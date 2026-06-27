FROM node:24-alpine AS web-builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.app.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm ci
RUN npm run build

FROM golang:1.26-alpine AS api-builder
WORKDIR /src

COPY backend/go.mod ./
RUN go mod download
COPY backend ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/bookreader ./cmd/server

FROM alpine:3.22
RUN apk --no-cache add ca-certificates poppler-utils tzdata
WORKDIR /app

COPY --from=api-builder /out/bookreader /app/bookreader
COPY --from=web-builder /app/dist /app/dist

ENV DATA_DIR=/data
ENV WEB_DIR=/app/dist
ENV PORT=8080

RUN addgroup -S -g 10001 app \
  && adduser -S -D -H -u 10001 -G app app \
  && mkdir -p /data/books \
  && chown -R app:app /app /data

USER app
EXPOSE 8080
CMD ["/app/bookreader"]
