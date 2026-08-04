# fhir-bridge — pure-Go static build on a distroless static base
# (MASTER-FR-072). No cgo dependencies (pgx / net-http are pure Go).
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.work.sum ./
COPY libs/go-common ./libs/go-common
COPY services/fhir-bridge ./services/fhir-bridge
RUN go work init ./libs/go-common ./services/fhir-bridge
WORKDIR /src/services/fhir-bridge
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/fhir-bridge ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/fhir-bridge /usr/bin/fhir-bridge
ENV LISTEN_ADDR=:8325
EXPOSE 8325
USER nonroot
ENTRYPOINT ["/usr/bin/fhir-bridge"]
