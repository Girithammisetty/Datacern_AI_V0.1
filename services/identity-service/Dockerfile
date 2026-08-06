# Build
FROM golang:1.26 AS build
WORKDIR /src
COPY go.work.sum ./
COPY libs/go-common ./libs/go-common
COPY services/identity-service ./services/identity-service
RUN go work init ./libs/go-common ./services/identity-service
WORKDIR /src/services/identity-service
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/identity-service ./cmd/server

# Run (distroless, non-root — MASTER-FR-072)
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/identity-service /identity-service
EXPOSE 8080
# 65532 numerically, not the `nonroot` NAME the distroless base defines.
# Kubernetes cannot resolve a username to a uid — it only sees the image config
# string — so with podSecurityContext.runAsNonRoot: true the kubelet refuses to
# start the container it cannot verify:
#   container has runAsNonRoot and image has non-numeric user (nonroot),
#   cannot verify user is non-root
# 65532 is the uid `nonroot` already maps to in distroless, so this changes who
# the process runs as not at all — only whether the kubelet can confirm it.
USER 65532:nonroot
ENTRYPOINT ["/identity-service"]
