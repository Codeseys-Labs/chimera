FROM public.ecr.aws/debian/debian:bookworm-slim
COPY packages/chat-gateway/dist/server.js ./
CMD ["bun", "server.js"]
