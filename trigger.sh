#!/bin/sh
curl -fsS -XPOST -H "x-api-key:${JOB_API_KEY}" "http://127.0.0.1:${JOB_PORT:-3889}/run"
