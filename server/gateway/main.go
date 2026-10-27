// Authentication facade and admin API for the chat backend.
//
// Two problems are solved here:
//
//  1. The backend consumes an account invite after a successful sign-up but
//     never rejects a code that was already used, so a leaked code would allow
//     unlimited registrations. /auth/register and /auth/account/create check
//     and consume the invite themselves.
//  2. The backend identifies accounts by e-mail. This deployment is invite-only
//     with nicknames, so accounts get a synthetic address that users never see;
//     /auth/login maps nickname -> address before calling the backend.
//
// Every admin route is guarded by the X-Admin-Token header (ADMIN_TOKEN env).
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

var (
	backendURL         = env("BACKEND_URL", "http://api:14702")
	mongoURL           = env("MONGO_URL", "mongodb://database:27017")
	mongoDB            = env("MONGO_DB", "revolt")
	listenAddr         = env("LISTEN_ADDR", ":8080")
	accountEmailDomain = env("ACCOUNT_EMAIL_DOMAIN", "users.localhost")
	adminToken         = env("ADMIN_TOKEN", "")
	vpnProfilePath     = env("VPN_PROFILE_PATH", "/app/client-profile.json")

	usernamePattern = regexp.MustCompile(`^[\p{L}\p{N}_.-]{2,32}$`)
	codePattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{4,32}$`)

	// Sign-ups are rare and manually approved: a single mutex keeps
	// "check invite, create account, consume invite" atomic.
	inviteMu sync.Mutex
)

type server struct {
	invites  *mongo.Collection
	users    *mongo.Collection
	accounts *mongo.Collection
	http     *http.Client
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(mongoURL))
	if err != nil {
		log.Fatalf("mongo: %v", err)
	}

	s := &server{
		invites:  client.Database(mongoDB).Collection("account_invites"),
		users:    client.Database(mongoDB).Collection("users"),
		accounts: client.Database(mongoDB).Collection("accounts"),
		http:     &http.Client{Timeout: 30 * time.Second},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusOK, []byte("ok"))
	})

	// Public (invite-gated) routes.
	mux.HandleFunc("POST /auth/register", s.handleRegister)
	mux.HandleFunc("POST /auth/login", s.handleLogin)
	mux.HandleFunc("GET /auth/username-available", s.handleUsernameAvailable)
	mux.HandleFunc("POST /auth/account/create", s.handleLegacyCreate)
	mux.HandleFunc("GET /vpn/profile", s.handleVpnProfile)

	// Admin routes.
	mux.HandleFunc("GET /admin/invites", s.admin(s.handleListInvites))
	mux.HandleFunc("POST /admin/invites", s.admin(s.handleCreateInvite))
	mux.HandleFunc("DELETE /admin/invites/{code}", s.admin(s.handleRevokeInvite))
	mux.HandleFunc("GET /admin/users", s.admin(s.handleListUsers))

	log.Printf("auth gateway listening on %s (backend %s, accounts @%s)", listenAddr, backendURL, accountEmailDomain)
	log.Fatal(http.ListenAndServe(listenAddr, mux))
}

func (s *server) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if adminToken == "" || r.Header.Get("X-Admin-Token") != adminToken {
			writeError(w, http.StatusUnauthorized, "InvalidCredentials")
			return
		}
		next(w, r)
	}
}

// handleRegister creates an account from nickname + password + invite.
func (s *server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Invite   string `json:"invite"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "IncorrectData")
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	req.Invite = strings.TrimSpace(req.Invite)

	switch {
	case !usernamePattern.MatchString(req.Username):
		writeError(w, http.StatusBadRequest, "InvalidUsername")
		return
	case len(req.Password) < 8 || len(req.Password) > 128:
		writeError(w, http.StatusBadRequest, "ShortPassword")
		return
	case req.Invite == "":
		writeError(w, http.StatusBadRequest, "MissingInvite")
		return
	}

	inviteMu.Lock()
	defer inviteMu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	free, err := s.inviteIsFree(ctx, req.Invite)
	if err != nil {
		log.Printf("register: invite lookup: %v", err)
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	if !free {
		writeError(w, http.StatusBadRequest, "InvalidInvite")
		return
	}

	taken, err := s.usernameTaken(ctx, req.Username)
	if err != nil {
		log.Printf("register: username lookup: %v", err)
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	if taken {
		writeError(w, http.StatusConflict, "UsernameTaken")
		return
	}

	email := syntheticEmail(req.Username)

	status, body, err := s.forward(ctx, http.MethodPost, "/auth/account/create", "", map[string]string{
		"email":    email,
		"password": req.Password,
		"invite":   req.Invite,
	})
	if err != nil {
		log.Printf("register: create account: %v", err)
		writeError(w, http.StatusBadGateway, "InternalError")
		return
	}
	if status < 200 || status >= 300 {
		writeRaw(w, status, body)
		return
	}

	// Log in right away: the session is what the client needs.
	status, session, err := s.forward(ctx, http.MethodPost, "/auth/session/login", "", map[string]string{
		"email":    email,
		"password": req.Password,
	})
	if err != nil || status != http.StatusOK {
		log.Printf("register: login after creation failed (status %d): %v", status, err)
		writeError(w, http.StatusBadGateway, "InternalError")
		return
	}

	var parsed struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(session, &parsed); err != nil || parsed.Token == "" {
		log.Printf("register: unexpected login response: %s", session)
		writeError(w, http.StatusBadGateway, "InternalError")
		return
	}

	// Nickname is applied through onboarding: it is the only place where the
	// backend checks the username rules and creates the profile. Note the
	// route is mounted at /onboard, not under /auth.
	status, onboarding, err := s.forward(ctx, http.MethodPost, "/onboard/complete", parsed.Token,
		map[string]string{"username": req.Username})
	if err != nil || status >= 300 {
		log.Printf("register: onboarding failed (status %d): %s", status, onboarding)
		writeRaw(w, status, onboarding)
		return
	}

	if _, err := s.invites.UpdateOne(ctx, bson.M{"_id": req.Invite}, bson.M{"$set": bson.M{"used": true}}); err != nil {
		// The account exists already; report success but keep a trace.
		log.Printf("register: mark invite %q used: %v", req.Invite, err)
	}

	writeRaw(w, http.StatusCreated, session)
}

// handleLogin turns nickname + password into a backend session.
func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "IncorrectData")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	email, err := s.emailForUsername(ctx, strings.TrimSpace(req.Username))
	if err != nil {
		// Do not disclose whether the nickname exists.
		writeError(w, http.StatusUnauthorized, "InvalidCredentials")
		return
	}

	status, body, err := s.forward(ctx, http.MethodPost, "/auth/session/login", "", map[string]string{
		"email":    email,
		"password": req.Password,
	})
	if err != nil {
		log.Printf("login: %v", err)
		writeError(w, http.StatusBadGateway, "InternalError")
		return
	}
	writeRaw(w, status, body)
}

func (s *server) handleUsernameAvailable(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if !usernamePattern.MatchString(username) {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "reason": "InvalidUsername"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	taken, err := s.usernameTaken(ctx, username)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": !taken})
}

// handleLegacyCreate keeps the backend-shaped sign-up endpoint gated too, so
// there is no path around the invite check.
func (s *server) handleLegacyCreate(w http.ResponseWriter, r *http.Request) {
	var body map[string]json.RawMessage
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "IncorrectData")
		return
	}

	var invite string
	if raw, ok := body["invite"]; ok {
		_ = json.Unmarshal(raw, &invite)
	}
	invite = strings.TrimSpace(invite)
	if invite == "" {
		writeError(w, http.StatusBadRequest, "MissingInvite")
		return
	}

	inviteMu.Lock()
	defer inviteMu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	free, err := s.inviteIsFree(ctx, invite)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	if !free {
		writeError(w, http.StatusBadRequest, "InvalidInvite")
		return
	}

	payload, err := json.Marshal(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "IncorrectData")
		return
	}
	status, response, err := s.forwardRaw(ctx, http.MethodPost, "/auth/account/create", "", payload)
	if err != nil {
		writeError(w, http.StatusBadGateway, "InternalError")
		return
	}

	if status >= 200 && status < 300 {
		if _, err := s.invites.UpdateOne(ctx, bson.M{"_id": invite}, bson.M{"$set": bson.M{"used": true}}); err != nil {
			log.Printf("legacy create: mark invite %q used: %v", invite, err)
		}
	}
	writeRaw(w, status, response)
}

func (s *server) handleListInvites(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	cursor, err := s.invites.Find(ctx, bson.M{}, options.Find().SetSort(bson.M{"_id": 1}))
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	defer cursor.Close(ctx)

	type invite struct {
		Code      string `bson:"_id" json:"code"`
		Used      bool   `bson:"used" json:"used"`
		ClaimedBy string `bson:"claimed_by" json:"claimed_by,omitempty"`
	}
	var result []invite
	if err := cursor.All(ctx, &result); err != nil {
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	if result == nil {
		result = []invite{}
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	_ = decode(r, &req)
	code := strings.TrimSpace(req.Code)
	if code == "" {
		code = randomHex(6)
	}
	if !codePattern.MatchString(code) {
		writeError(w, http.StatusBadRequest, "IncorrectData")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	_, err := s.invites.InsertOne(ctx, bson.M{"_id": code, "used": false})
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			writeError(w, http.StatusConflict, "InviteExists")
			return
		}
		log.Printf("create invite: %v", err)
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"code": code})
}

func (s *server) handleRevokeInvite(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	if !codePattern.MatchString(code) {
		writeError(w, http.StatusBadRequest, "IncorrectData")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	result, err := s.invites.DeleteOne(ctx, bson.M{"_id": code})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	if result.DeletedCount == 0 {
		writeError(w, http.StatusNotFound, "NotFound")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}

func (s *server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	projection := options.Find().SetProjection(bson.M{"username": 1, "discriminator": 1}).SetSort(bson.M{"username": 1})
	cursor, err := s.users.Find(ctx, bson.M{}, projection)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	defer cursor.Close(ctx)

	type user struct {
		ID            string `bson:"_id" json:"id"`
		Username      string `bson:"username" json:"username"`
		Discriminator string `bson:"discriminator" json:"discriminator"`
	}
	var result []user
	if err := cursor.All(ctx, &result); err != nil {
		writeError(w, http.StatusServiceUnavailable, "InternalError")
		return
	}
	if result == nil {
		result = []user{}
	}
	writeJSON(w, http.StatusOK, result)
}

// inviteIsFree reports whether the code exists and has not been consumed.
func (s *server) inviteIsFree(ctx context.Context, code string) (bool, error) {
	var doc struct {
		Used bool `bson:"used"`
	}
	err := s.invites.FindOne(ctx, bson.M{"_id": code}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return !doc.Used, nil
}

func (s *server) usernameTaken(ctx context.Context, username string) (bool, error) {
	count, err := s.users.CountDocuments(ctx, bson.M{
		"username": bson.M{"$regex": "^" + regexp.QuoteMeta(username) + "$", "$options": "i"},
	})
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// emailForUsername resolves the synthetic address of an account.
func (s *server) emailForUsername(ctx context.Context, username string) (string, error) {
	if username == "" {
		return "", mongo.ErrNoDocuments
	}

	var user struct {
		ID string `bson:"_id"`
	}
	err := s.users.FindOne(ctx, bson.M{
		"username": bson.M{"$regex": "^" + regexp.QuoteMeta(username) + "$", "$options": "i"},
	}, options.FindOne().SetProjection(bson.M{"_id": 1})).Decode(&user)
	if err != nil {
		return "", err
	}

	var account struct {
		Email string `bson:"email"`
	}
	err = s.accounts.FindOne(ctx, bson.M{"_id": user.ID}, options.FindOne().SetProjection(bson.M{"email": 1})).Decode(&account)
	if err != nil {
		return "", err
	}
	if account.Email == "" {
		return "", mongo.ErrNoDocuments
	}
	return account.Email, nil
}

// handleVpnProfile hands the client its tunnel profile (VLESS + Reality).
//
// The profile is rendered by scripts/gen-config.sh on the host and mounted
// read-only, so the keys stay in the deployment directory. Only sessions the
// backend recognises as valid get it.
func (s *server) handleVpnProfile(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("X-Session-Token")
	if token == "" {
		writeError(w, http.StatusUnauthorized, "InvalidCredentials")
		return
	}

	status, _, err := s.forwardRaw(r.Context(), http.MethodGet, "/users/@me", token, nil)
	if err != nil {
		log.Printf("vpn profile: session check: %v", err)
		writeError(w, http.StatusBadGateway, "InternalError")
		return
	}
	if status != http.StatusOK {
		writeError(w, http.StatusUnauthorized, "InvalidCredentials")
		return
	}

	body, err := os.ReadFile(vpnProfilePath)
	if err != nil {
		log.Printf("vpn profile: read %s: %v", vpnProfilePath, err)
		writeError(w, http.StatusServiceUnavailable, "VpnProfileUnavailable")
		return
	}

	writeRaw(w, http.StatusOK, body)
}

func (s *server) forward(ctx context.Context, method, path, token string, payload any) (int, []byte, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	return s.forwardRaw(ctx, method, path, token, encoded)
}

func (s *server) forwardRaw(ctx context.Context, method, path, token string, payload []byte) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, backendURL+path, bytes.NewReader(payload))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("X-Session-Token", token)
	}

	response, err := s.http.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	if err != nil {
		return 0, nil, err
	}
	return response.StatusCode, body, nil
}

// syntheticEmail builds the invisible login address for a nickname.
func syntheticEmail(username string) string {
	var slug strings.Builder
	for _, r := range strings.ToLower(username) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			slug.WriteRune(r)
		default:
			slug.WriteRune('-')
		}
	}

	value := strings.Trim(slug.String(), "-._")
	if value == "" {
		value = "user"
	}
	if len(value) > 24 {
		value = value[:24]
	}
	return value + "-" + randomHex(4) + "@" + accountEmailDomain
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return strings.Repeat("0", n*2)
	}
	return hex.EncodeToString(buf)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func decode(r *http.Request, target any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, target)
}

func writeError(w http.ResponseWriter, status int, kind string) {
	writeJSON(w, status, map[string]string{"type": kind})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "encoding error", http.StatusInternalServerError)
		return
	}
	writeRaw(w, status, encoded)
}

func writeRaw(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
