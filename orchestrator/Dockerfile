FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/orchestrator ./cmd/orchestrator

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/orchestrator /orchestrator
EXPOSE 8080
ENTRYPOINT ["/orchestrator"]
