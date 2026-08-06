# audit-service — static build on a distroless base (MASTER-FR-072). No cgo:
# the ClickHouse, MinIO, Kafka and Parquet clients are all pure Go.
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.work.sum ./
COPY libs/go-common ./libs/go-common
COPY services/audit-service ./services/audit-service
RUN go work init ./libs/go-common ./services/audit-service
WORKDIR /src/services/audit-service
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/audit-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/audit-service /usr/bin/audit-service
# 65532 numerically, not the `nonroot` NAME the distroless base defines.
# Kubernetes cannot resolve a username to a uid — it only sees the image config
# string — so with podSecurityContext.runAsNonRoot: true the kubelet refuses to
# start the container it cannot verify:
#   container has runAsNonRoot and image has non-numeric user (nonroot),
#   cannot verify user is non-root
# 65532 is the uid `nonroot` already maps to in distroless, so this changes who
# the process runs as not at all — only whether the kubelet can confirm it.
USER 65532
ENTRYPOINT ["/usr/bin/audit-service"]
