// Reloved pipeline. Runs on the Jenkins in ci/jenkins (Docker). GitHub Actions keeps running too.
// Stages: API tests -> secrets/dependency/code scans -> browser tests -> load tests -> ZAP scan.
pipeline {
  agent any
  options { timestamps(); timeout(time: 45, unit: 'MINUTES'); disableConcurrentBuilds(); buildDiscarder(logRotator(numToKeepStr: '20')) }
  triggers { pollSCM('H/5 * * * *') }
  environment {
    CI = 'true'
    PGHOST = 'postgres'
    PGUSER = 'postgres'
    PGPASSWORD = 'postgres'
  }
  stages {
    stage('Install') {
      steps {
        dir('server') { sh 'npm ci' }
        dir('e2e') { sh 'npm ci' }
      }
    }
    stage('API: typecheck and tests') {
      steps {
        dir('server') {
          sh 'npm run typecheck'
          sh 'npm test -- --reporter=default --reporter=junit --outputFile.junit=../reports/api-junit.xml'
        }
      }
      post { always { junit allowEmptyResults: true, testResults: 'reports/api-junit.xml' } }
    }
    stage('Security scans') {
      parallel {
        stage('Dependencies') {
          steps { dir('server') { sh 'npm audit --omit=dev --audit-level=high' } }
        }
        stage('Secrets (gitleaks)') {
          steps { sh 'mkdir -p reports && docker run --rm --volumes-from jenkins -w "$PWD" zricethezav/gitleaks:latest detect --source . --redact --report-format json --report-path reports/gitleaks.json' }
        }
        stage('Code (semgrep)') {
          steps { sh 'mkdir -p reports && docker run --rm --volumes-from jenkins -w "$PWD" semgrep/semgrep semgrep scan --config p/typescript --config p/javascript --config p/owasp-top-ten --error --json -o reports/semgrep.json server/src app.js' }
        }
      }
    }
    stage('Start test copy of the app') {
      steps { sh 'bash ci/jenkins/scripts/stack-up.sh' }
    }
    stage('Browser tests (Playwright)') {
      steps {
        dir('e2e') {
          sh 'npx playwright install --with-deps chromium'
          sh 'npx playwright test'
        }
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'e2e/results/junit.xml'
          archiveArtifacts allowEmptyArchive: true, artifacts: 'e2e/results/**'
        }
      }
    }
    stage('Load tests (k6)') {
      steps {
        sh 'mkdir -p reports'
        sh 'docker run --rm -u root --network container:jenkins --volumes-from jenkins -w "$PWD" -e BASE_URL=http://127.0.0.1:4000 grafana/k6 run --summary-export=reports/k6-smoke.json load/smoke.js'
        sh 'docker run --rm -u root --network container:jenkins --volumes-from jenkins -w "$PWD" -e BASE_URL=http://127.0.0.1:4000 grafana/k6 run load/ratelimit.js'
      }
    }
    stage('Web scan (OWASP ZAP baseline)') {
      steps {
        sh 'mkdir -p reports; docker rm -f zap >/dev/null 2>&1 || true'
        // -I: report warnings without failing the build (tighten later once the baseline is clean)
        sh 'docker run --name zap --network container:jenkins ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t http://localhost:5173 -r zap.html -I'
        sh 'docker cp zap:/zap/wrk/zap.html reports/zap.html'
        sh 'docker rm -f zap || true'
      }
    }
  }
  post {
    always {
      sh 'bash ci/jenkins/scripts/stack-down.sh || true'
      archiveArtifacts allowEmptyArchive: true, artifacts: 'reports/**'
      cleanWs()
    }
  }
}
