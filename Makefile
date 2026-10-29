NODE ?= node
PNPM ?= pnpm
ORCAPOD = $(NODE) bin/orcapod.js

.DEFAULT_GOAL := help
.PHONY: help start daemon stop monitor status validate doctor logs check typecheck lint test

help:
	@printf '%s\n' \
		'make start     Start the daemon in the background and open the monitor (q to quit)' \
		'make daemon    Run the daemon in the foreground (Ctrl-C to stop)' \
		'make stop      Ask the daemon to stop' \
		'make monitor   Open the monitor (q to quit)' \
		'make status    Print the status once' \
		'make validate  Validate the configuration' \
		'make doctor    Diagnose the environment' \
		'make logs      Follow the log (Ctrl-C to stop)' \
		'make check     Run typecheck, lint and all tests' \
		'make typecheck Run the typecheck' \
		'make lint      Run lint' \
		'make test      Run all tests'

start:
	$(ORCAPOD) up

daemon:
	$(ORCAPOD) start

stop:
	$(ORCAPOD) stop

monitor:
	$(ORCAPOD) monitor

status:
	$(ORCAPOD) status

validate:
	$(ORCAPOD) validate

doctor:
	$(ORCAPOD) doctor

logs:
	$(ORCAPOD) logs -f

check: typecheck lint test

typecheck:
	$(PNPM) typecheck

lint:
	$(PNPM) lint

test:
	$(PNPM) test
