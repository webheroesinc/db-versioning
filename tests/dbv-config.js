const path					= require('path');
const log					= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.DEBUG_LEVEL || "fatal",
});

const prompter					= require('@whi/prompter');
const knex					= require('knex');
const waitUntil					= require('async-wait-until');
const sprintf					= require('sprintf-js').sprintf;

let conn;

process.on("unhandledRejection", (reason, p) => {
    log.fatal("Unhandled Rejection at Promise %s for reason: %s", p, reason);
    process.exit(1);
});


const db_filepath				= "./tests.sqlite";

const config = {
    context: async function () {
	await waitUntil(() => {
	    return conn !== undefined;
	}, 5000, 100 );

	return conn;
    },
    contextID: async function () {
	return db_filepath;
    },
    teardown: async function () {
	log.debug("Closing db connection pool");
	conn.destroy();
    },
    currentVersion: async function () {
	var rows				= await conn("metadata")
	    .where("name", "version");
	return rows[0].value;
    },
    setVersion: async function ( version ) {
	await conn("metadata")
	    .where("name", "version")
	    .update("value", version);

	const v					= version.split(".").map(function(n) {
	    try {
		return parseInt(n);
	    } catch (_) {
		return n;
	    }
	});
	
	await conn("metadata")
	    .where("name", "version_info")
	    .update("value", JSON.stringify({
		"major": v[0],
		"minor": v[1],
		"patch": v[2],
	    }) );
    },
    isInstalled: async function () {
	log.debug("Check if installed");
	return await conn.schema.hasTable( "metadata" );
    },
    install: async function () {
	log.debug("Creating table");
	await conn.schema.createTable("metadata", function (table) {
	    table.increments("metadata_id").primary();
	    table.string("name", 255);
	    table.text("value", "mediumtext");
	    table.specificType("created", "datetime2").defaultTo( conn.fn.now() );
	});

	log.debug("Inserting version rows");
	await conn("metadata").insert([
	    {
		"name": "version",
		"value": "0.0.0",
	    },
	    {
		"name": "version_info",
		"value": JSON.stringify({
		    "major": 0,
		    "minor": 0,
		    "patch": 0,
		}),
	    }
	]);

	return true;
    },
    uninstall: async function () {
	log.info("Dropping 'metadata' table");
	const resp				= await conn.schema.dropTable("metadata");
	log.info("Dropped table: %s", resp);

	return true;
    },
};


async function connect() {
    console.log("Connecting to database...");
    conn					= knex({
	"client": "sqlite3",
	"connection": {
	    "filename": db_filepath,
	},
	"useNullAsDefault": true,
    });
}
connect();


module.exports = config;
