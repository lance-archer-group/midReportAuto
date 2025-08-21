#!/bin/sh
set -eu
: "${JOB_PORT:=3889}"
: "${JOB_API_KEY:?set JOB_API_KEY in the container env}"

curl -fsS --retry 3 --retry-connrefused --max-time 60 \
  -H "x-api-key:${JOB_API_KEY}" \
  "http://127.0.0.1:${JOB_PORT}/run/"
