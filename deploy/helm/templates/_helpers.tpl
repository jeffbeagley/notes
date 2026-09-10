{{- define "notes.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "notes.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{ else }}{{ printf "%s-%s" .Release.Name (include "notes.name" .) | trunc 63 | trimSuffix "-" }}{{ end }}
{{- end }}

{{- define "notes.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "notes.labels" -}}
helm.sh/chart: {{ include "notes.chart" . }}
app.kubernetes.io/name: {{ include "notes.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: notes
{{- end }}

{{- define "notes.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ default (include "notes.fullname" .) .Values.serviceAccount.name }}{{ else }}{{ default "default" .Values.serviceAccount.name }}{{ end }}
{{- end }}

{{- define "notes.secretName" -}}
{{- default (printf "%s-secrets" (include "notes.fullname" .)) .Values.secrets.existingSecret }}
{{- end }}

{{/* Image references, honouring an optional digest pin over the tag. */}}
{{- define "notes.api.image" -}}
{{- if .Values.api.image.digest }}{{ printf "%s@%s" .Values.api.image.repository .Values.api.image.digest }}{{ else }}{{ printf "%s:%s" .Values.api.image.repository (default .Chart.AppVersion .Values.api.image.tag) }}{{ end }}
{{- end }}

{{- define "notes.web.image" -}}
{{- if .Values.web.image.digest }}{{ printf "%s@%s" .Values.web.image.repository .Values.web.image.digest }}{{ else }}{{ printf "%s:%s" .Values.web.image.repository (default .Chart.AppVersion .Values.web.image.tag) }}{{ end }}
{{- end }}

{{/* Shared by the API Deployment and the migration Job so the two can never drift. */}}
{{- define "notes.api.envFrom" -}}
- configMapRef:
    name: {{ include "notes.fullname" . }}-config
- secretRef:
    name: {{ include "notes.secretName" . }}
{{- with .Values.api.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}