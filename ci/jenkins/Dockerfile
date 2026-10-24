# Jenkins with everything the Reloved pipeline needs, so the pipeline itself needs nothing installed on your computer.
FROM jenkins/jenkins:lts-jdk17
USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg git postgresql-client python3 python3-venv procps unzip \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (same as production).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# Browser for the end-to-end tests. The version must equal "@playwright/test" in e2e/package.json.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npm install -g playwright@1.63.0 && playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

# Docker command line (talks to your Docker Desktop through the mounted socket) for the OWASP ZAP scan.
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz | tar -xz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker && rm -rf /tmp/docker

# k6 (load tests) and gitleaks (secret scan).
RUN curl -fsSL https://github.com/grafana/k6/releases/download/v0.49.0/k6-v0.49.0-linux-amd64.tar.gz | tar -xz -C /tmp \
    && mv /tmp/k6-v0.49.0-linux-amd64/k6 /usr/local/bin/k6 \
    && curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz | tar -xz -C /usr/local/bin gitleaks

# semgrep (static code analysis).
RUN python3 -m venv /opt/semgrep && /opt/semgrep/bin/pip install --no-cache-dir semgrep && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep

USER jenkins
COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt
