
package-lock.json:	package.json
	npm install
	touch $@
node_modules:		package-lock.json
	npm install
	touch $@

test:			node_modules
	@echo "Running tests $$(date -u --iso-8601=seconds)" >> main.log
	./main.js --config tests/dbv-config.js install

#
# NPM Package
#
clean-files:
	git clean -fdX -e 'node_modules'
preview-package:	clean-files test
	npm pack --dry-run .
create-package:		clean-files test
	npm pack .
publish-package:	clean-files test
	npm publish --access public .
