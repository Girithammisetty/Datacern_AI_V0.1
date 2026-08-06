# query-service — CGO build (DuckDB engine) on a distroless glibc base
# (MASTER-FR-072).
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.work.sum ./
COPY libs/go-common ./libs/go-common
COPY services/query-service ./services/query-service
RUN go work init ./libs/go-common ./services/query-service
WORKDIR /src/services/query-service
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/query-service ./cmd/server

# distroless/base carries glibc (required by the cgo DuckDB driver);
# static-debian would not.
FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=build /out/query-service /usr/bin/query-service
ENV RESULTS_ROOT=/var/lib/query-service
# 65532 numerically, not the `nonroot` NAME the distroless base defines.
# Kubernetes cannot resolve a username to a uid — it only sees the image config
# string — so with podSecurityContext.runAsNonRoot: true the kubelet refuses to
# start the container it cannot verify:
#   container has runAsNonRoot and image has non-numeric user (nonroot),
#   cannot verify user is non-root
# 65532 is the uid `nonroot` already maps to in distroless, so this changes who
# the process runs as not at all — only whether the kubelet can confirm it.
USER 65532
ENTRYPOINT ["/usr/bin/query-service"]
