# Build context: this directory, after `npm run build` (dist/ is self-contained, no node_modules).
FROM node:22-alpine
WORKDIR /app
COPY dist/server ./server
ENV PORT=8787 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8787
USER node
CMD ["node", "server/index.mjs"]
