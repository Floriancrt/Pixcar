# API Pixcar (réparations déclarées + relais Overpass). La page, elle, se publie à part : dist/ sur un hébergeur
# statique ou un CDN (voir docs/exploitation.md).
#
#   docker build -t pixcar-api .
#   docker run --rm -p 8080:8080 --env-file api.env pixcar-api
#
# Variables obligatoires en production : DATABASE_URL, ALLOWED_ORIGINS, PLATE_PEPPER, IP_PEPPER (voir docs/exploitation.md).
# Aucune n'est dans l'image : le démarrage échoue avec un message clair si l'une manque.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
# Arrêt : 3 s pendant lesquelles /readyz répond 503 (le répartiteur retire l'instance), puis 5 s au plus pour finir les
# requêtes en cours — moins que les 10 s qu'« docker stop » laisse avant d'envoyer SIGKILL.
ENV NODE_ENV=production PORT=8080 DRAIN_MS=3000 SHUTDOWN_GRACE_MS=5000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY db ./db
# l'API partage avec la page ses règles de validation, ses prestations et sa requête Overpass : une seule source
COPY src/js/package.json ./src/js/package.json
COPY src/js/shared ./src/js/shared
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
