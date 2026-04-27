FROM public.ecr.aws/debian/debian:bookworm-slim
# Old approach: ENV NODE_OPTIONS=--require ./instrument.js
COPY packages/chat-gateway/dist/server.js ./
CMD ["bun", "server.js"]
