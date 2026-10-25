// Invite gate for account creation.
//
// The chat backend consumes an account invite after a successful sign-up but
// never rejects a code that was already used, so a leaked code would allow
// unlimited registrations. This service is the only public route to
// /auth/account/create: it checks the invite is still free, forwards the
// request to the backend and only then marks the invite as used.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const collection = "account_invites"

var (
	backendURL = env("BACKEND_URL", "http://api:14702")
	mongoURL   = env("MONGO_URL", "mongodb://database:27017")
	mongoDB    = env("MONGO_DB", "revolt")
	listenAddr = env("LISTEN_ADDR", ":8080")

	// Sign-ups are rare and manually invited, a single mutex is enough to make
	// "check the invite, then consume it" atomic between concurrent requests.
	inviteMu sync.Mutex
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(mongoURL))
	if err != nil {
		log.Fatalf("mongo: %v", err)
	}
	invites := client.Database(mongoDB).Collection(collection)

	proxyClient := &http.Client{Timeout: 30 * time.Second}

	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	http.HandleFunc("/auth/account/create", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
		if err != nil {
			http.Error(w, "cannot read body", http.StatusBadRequest)
			return
		}

		var payload struct {
			Invite string `json:"invite"`
		}
		_ = json.Unmarshal(body, &payload)
		payload.Invite = strings.TrimSpace(payload.Invite)

		if payload.Invite == "" {
			writeJSON(w, http.StatusBadRequest, `{"type":"MissingInvite"}`)
			return
		}

		inviteMu.Lock()
		defer inviteMu.Unlock()

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		var doc struct {
			ID  string `bson:"_id"`
			Used bool  `bson:"used"`
		}
		err = invites.FindOne(ctx, bson.M{"_id": payload.Invite}).Decode(&doc)
		if err == mongo.ErrNoDocuments {
			writeJSON(w, http.StatusBadRequest, `{"type":"InvalidInvite"}`)
			return
		}
		if err != nil {
			log.Printf("lookup invite: %v", err)
			http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
			return
		}
		if doc.Used {
			writeJSON(w, http.StatusBadRequest, `{"type":"InvalidInvite"}`)
			return
		}

		status, respBody, contentType, err := forward(proxyClient, body)
		if err != nil {
			log.Printf("forward: %v", err)
			http.Error(w, "backend unavailable", http.StatusBadGateway)
			return
		}

		if status >= 200 && status < 300 {
			update := bson.M{"used": true}
			_, err = invites.UpdateOne(ctx, bson.M{"_id": payload.Invite}, bson.M{"$set": update})
			if err != nil {
				// The account exists already; report success but keep a trace.
				log.Printf("mark invite %q used: %v", payload.Invite, err)
			}
		}

		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(status)
		_, _ = w.Write(respBody)
	})

	log.Printf("invite gate listening on %s (backend %s)", listenAddr, backendURL)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}

func forward(client *http.Client, body []byte) (int, []byte, string, error) {
	request, err := http.NewRequest(http.MethodPost, backendURL+"/auth/account/create", bytes.NewReader(body))
	if err != nil {
		return 0, nil, "", err
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := client.Do(request)
	if err != nil {
		return 0, nil, "", err
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	if err != nil {
		return 0, nil, "", err
	}
	return response.StatusCode, responseBody, response.Header.Get("Content-Type"), nil
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}
