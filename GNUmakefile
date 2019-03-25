
install:
	npm i
tests:
	@echo "Running tests $$(date -u --iso-8601=seconds)" >> main.log
	./main.js -vvvvvv install
logs:
	grc tail -f main.log
