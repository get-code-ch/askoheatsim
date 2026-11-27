# Image autonome du simulateur ASKOHEAT+, pour un usage hors du cluster (poste de travail, Raspberry Pi,
# NAS, démo sur un portable…). Le cluster n'utilise pas cette image : Argo CD monte le code depuis une
# ConfigMap dans python:3.13-slim (voir kustomization.yaml).
#
#   docker build -t askoheatsim .
#   docker run -d --name askoheatsim -p 8080:8080 -p 502:5020 -v askoheatsim-state:/data askoheatsim
#
# ou : docker compose up -d   (compose.yaml)
ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="askoheatsim" \
      org.opencontainers.image.description="Simulateur Modbus TCP de l'ASKOHEAT+ 2.0 (Domotec DWP EHF 3.5 PV F 2.0) avec interface web" \
      org.opencontainers.image.source="https://github.com/get-code-ch/askoheatsim" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# Mêmes valeurs par défaut que k8s/deployment.yaml ; toutes surchargeables avec -e / environment:
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODBUS_PORT=5020 \
    HTTP_PORT=8080 \
    TANK_LITERS=300 \
    START_TEMP=45 \
    INPUT_SETTING=0x2FC \
    MIN_TEMP=45 \
    AUTO_OFF=0b01 \
    COMPENSATE=true \
    TZ_NAME=Europe/Zurich \
    STATE_FILE=/data/state.json

WORKDIR /app
COPY askoheat_sim.py household.py registers.py index.html app.js trace.js config.js ./

# Répertoire d'état : un volume nommé hérite de ce propriétaire (utilisateur nobody, comme sur le cluster)
RUN mkdir /data && chown 65534:65534 /data
VOLUME ["/data"]

USER 65534:65534
EXPOSE 5020 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('HTTP_PORT', '8080'), timeout=2)"]

# SIGTERM (docker stop) : le simulateur sauvegarde son état puis s'arrête proprement
STOPSIGNAL SIGTERM
CMD ["python", "/app/askoheat_sim.py"]
