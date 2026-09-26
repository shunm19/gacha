# All sui CLI calls use the project-local testnet config in .sui/ (never ~/.sui).
SUI := sui client --client.config .sui/client.yaml

.PHONY: wallet address balance test build cards deploy seed seed-batch dev
wallet:        ## create the throwaway testnet key in .sui/
	@test -f .sui/client.yaml || (mkdir -p .sui && $(SUI) -y active-address > .sui/init.log 2>&1)
	@$(SUI) active-address
address:
	@$(SUI) active-address
balance:
	@$(SUI) balance
test:
	cd move/oripa && sui move test
build:
	cd move/oripa && sui move build
cards:         ## psa-data -> frontend/public (images, metadata) + scripts/pool_spec.json
	python3 scripts/export_cards.py
deploy:        ## publish + make_immutable in one tx
	npx tsx scripts/deploy.ts
seed:          ## instant pool from pool_spec.json
	npx tsx scripts/seed.ts
seed-batch:    ## batch pool (sale ends in 20 min)
	npx tsx scripts/seed.ts --batch --minutes 20 --count 12
dev:
	cd frontend && npm run dev -- --port 5173
