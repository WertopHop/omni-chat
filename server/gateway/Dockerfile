FROM docker.io/golang:1.24-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY main.go ./
# go mod tidy resolves the mongo-driver dependency tree inside the build stage.
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -o /gateway .

FROM docker.io/alpine:3.20

COPY --from=build /gateway /gateway
ENTRYPOINT ["/gateway"]
