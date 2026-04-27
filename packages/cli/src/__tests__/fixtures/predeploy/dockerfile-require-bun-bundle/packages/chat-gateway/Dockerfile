FROM public.ecr.aws/debian/debian:bookworm-slim
WORKDIR /app
COPY packages/chat-gateway/dist/server.js ./
ENV NODE_OPTIONS=--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register
CMD ["bun", "server.js"]
