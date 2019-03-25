#!/usr/bin/env node

const path					= require('path');
const log					= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.DEBUG_LEVEL || 'silly',
});
const print					= require('@whi/printjs').colorAlways();
const prompter					= require('@whi/prompter');

const fs					= require('fs');
const compareVersions				= require('compare-versions');
const commander					= require('commander');

process.on('unhandledRejection', (reason, p) => {
    log.fatal('Unhandled Rejection at Promise %s for reason: %s', p, reason);
    console.error( p );
    process.exit(1);
});

const cwd					= process.cwd();
let db, config, context;

async function loadConfig( configFile = './dbv-config.js' ) {
    configFile					= configFile[0] === '/'
	? configFile
	: cwd + '/' + configFile;

    log.debug("Loading config file: %s", configFile);
    config					= require( configFile );
    log.debug("Getting db context");
    context					= await config.context();
    contextID					= await config.contextID();
    log.debug("Aquired context: %s", typeof context );
}

async function exit(n) {
    log.debug("Finished, running config.teardown");
    config.teardown();
    process.exit(n);
}

function versionSort(packA, packB) {
    return compareVersions( packA.version.name, packB.version.name );
}

function getVersionPacks( startVersion, endVersion ) {
    log.info("Collecting vpacks for %s-%s", startVersion, endVersion);
    
    return new Promise(function (f,r) {
	let vpacks				= [];
	fs.readdir( cwd + '/versions', (err, files) => {
	    files.forEach(file => {
		if ( file.slice(-3) !== '.js' )
		    return;

		try {
		    let [ v, ...name ]		= file.split('-');
		    let module			= require( cwd + '/versions/' + file );
		    let version			= v.split('.').map( n => parseInt(n) );
		    name			= name.join(' ').slice(0,-3);

		    if ( compareVersions( v, startVersion ) !== 1 ||
			 compareVersions( v, endVersion ) === 1 ) {
			log.debug("Skipping version %-8.8s (%s) because is outside range %s-%s", v, name, startVersion, endVersion);
			return;
		    }
		    
		    vpacks.push({
			name,
			path: cwd + '/versions/' + file,
			version: {
			    name: v,
			    major: version[0],
			    minor: version[1],
			    patch: version[2],
			},
			module,
		    });
		    
		} catch (err) {
		    log.error("Failed to load vpack: %s", err);
		    console.error( err );
		}
	    });

	    vpacks.sort( versionSort );
	    f( vpacks );
	});
    });
}

async function main ( argv ) {

    function increaseVerbosity(v, total) {
	return total + 1;
    }
    function addRelative(v) {
	if ( v[0] !== '/' && v.slice(0,2) !== './' )
	    return './' + v;
    }

    async function runCommand(command, args, cmdopts, opts) {
	// Set logging verbosity for console transport
	log.transports[0].setLevel( opts.verbose );
	if ( process.env.DEBUG_LEVEL )
	    print("Log level set to %d:%s", opts.verbose || 0, log.transports[0].level);

	await loadConfig( opts.config );
	print("Using context %s", contextID);

	if ( command !== 'install' ) {
	    log.debug("Check installed");
	    if ( ! await config.isInstalled() ) {
		print("dbv is not installed.  Must run 'dbv install' first.");
		exit( 1 );
	    }
	}

	async function getCurrentVersion() {
	    let cv;
	    
	    if ( opts.override ) {
		cv				= opts.override;
		log.debug("Version override is set to %s", cv);
	    } else {
		cv				= await config.currentVersion();
		log.debug("Current version is %s",  cv );
	    }
	    
	    return cv;
	}
	
	log.debug("Running subcommand %s", command);
	let vpacks, version,
	    currentVersion			= await getCurrentVersion();
	try {
	    switch( command ) {
	    case 'version':
		print("Current version is %s", currentVersion);
		break;
	    case 'install':
		await config.install();
		break;
	    case 'uninstall':
		await config.uninstall();
		break;
	    case 'upgrade':
		dryRun				= cmdopts.dryRun;
		version				= args[0];
		currentVersion			= await getCurrentVersion();

		if ( compareVersions( currentVersion, version ) !== -1 ) {
		    print("Unable to upgrade. Current version (%s) is not lower than given version (%s)", currentVersion, version);
		    break;
		}

		vpacks				= await getVersionPacks( currentVersion, version );

		print("Preview list of packages that will or will NOT run (packs: %d):", vpacks.length);
		for (var i=0; i < vpacks.length; i++ ) {
		    let pack			= vpacks[i];
		    let passed			= await pack.module.check.call( pack, context );
		    print("  - %12.12s upgrade for package %-8.8s (%s)", !passed ? 'Will run' : 'Will NOT run', pack.version.name, pack.name );
		}

		if ( !(dryRun || cmdopts.yes) )
		    if ( ! await prompter.confirm("Proceed with upgrade for context " + contextID + "?", "n") )
			break;

		for (var i=0; i < vpacks.length; i++ ) {
		    let pack			= vpacks[i];
		    let passed			= await pack.module.check.call( pack, context );

		    log.debug("Version %-10.10s result: %5.5s (dry run: %s)", pack.version.name, passed, dryRun);
		    if ( ! passed ) {
			if ( dryRun )
			    print("Would have run upgrade for version %-8.8s (%s)", pack.version.name, pack.name);
			else {
			    try {
				log.info("Running upgrade %s", pack.version.name);
				await pack.module.upgrade.call( pack, context );

				passed		= await pack.module.check.call( pack, context );
				if ( !passed ) {
				    print("    Failed to upgrade to version %-8.8s (%s)", pack.version.name, pack.name)
				    throw new Error("Failed to pass pack.check().  Either your upgrade is incomplete or your check is misconfigured.");
				}

				print("Successfully upgraded to version %-8.8s (%s)", pack.version.name, pack.name);

				await config.packComplete( pack, 'upgrade', pack.version.name );
			    } catch (err) {
				console.log( err );
				log.fatal("Upgrade failed, running downgrade to rollback changes");
				await pack.module.downgrade.call( pack, context );
			    }
			}
			
		    }
		}
		print("Version is now set to %s", await config.currentVersion());
		break;
	    case 'downgrade':
		dryRun				= cmdopts.dryRun;
		version				= args[0];
		currentVersion			= await getCurrentVersion();
		vpacks				= await getVersionPacks( version, currentVersion );

		if ( compareVersions( currentVersion, version ) !== 1 ) {
		    print("Unable to downgrade. Current version (%s) is not higher than given version (%s)", currentVersion, version);
		    break;
		}

		print("Preview list of packages that will or will NOT run (packs: %d):", vpacks.length);
		for (var i=vpacks.length-1; i >= 0; i-- ) {
		    let pack			= vpacks[i];
		    let passed			= await pack.module.check.call( pack, context );
		    print("  - %12.12s downgrade for package %-8.8s (%s)", passed ? 'Will run' : 'Will NOT run', pack.version.name, pack.name );
		}

		if ( !(dryRun || cmdopts.yes) )
		    if ( ! await prompter.confirm("Proceed with downgrade for context " + contextID + "?", "n") )
			break;

		for (var i=vpacks.length-1; i >= 0; i-- ) {
		    let pack			= vpacks[i];
		    let passed			= await pack.module.check.call( pack, context );

		    log.debug("Version %-10.10s result: %5.5s (dry run: %s)", pack.version.name, passed, dryRun);
		    if ( passed ) {
			if ( dryRun )
			    print("Would have run downgrade for version %-8.8s (%s)", pack.version.name, pack.name);
			else {
			    await pack.module.downgrade.call( pack, context );
			    passed		= await pack.module.check.call( pack, context );
			    if ( passed ) {
				print("    Failed to downgrade version %-8.8s (%s)", pack.version.name, pack.name)
				throw new Error("Failed to pass pack.check().  Either your downgrade is incomplete or your check is misconfigured.");
			    }

			    print("Successfully downgraded version %-8.8s (%s)", pack.version.name, pack.name);

			    let newVersion	= vpacks[i-1]
				? vpacks[i-1].version.name
				: version;
			    await config.packComplete( pack, 'downgrade', newVersion );
			}
			
		    }
		}
		print("Version is now set to %s", await config.currentVersion());
		break;
	    }
	    log.silly( JSON.stringify( vpacks, null, 4 ) );
	} catch (err) {
	    console.error( err );
	    exit( 1 );
	}
	
	exit( 0 );
    }
    
    commander
	.version('1.0.0')
	.option('-v, --verbose', 'Increase logging verbosity', increaseVerbosity, 0)
	.option('-c, --config [path]', 'Configuration file for database connection', addRelative)
	.option('-o, --override [version]', 'Manually override the current version');
    
    commander
	.command('version')
	.description("Get the database current version")
	.action(async function () {
	    await runCommand('version', [], this, this.parent);
	});

    commander
	.command('install')
	.description("Install version tracking requirements.  Calls 'config.install'")
	.action(async function () {
	    await runCommand('install', [], this, this.parent);
	});
    
    commander
	.command('uninstall')
	.description("Uninstall version tracking requirements.  Calls 'config.uninstall'")
	.action(async function () {
	    await runCommand('uninstall', [], this, this.parent);
	});
    
    commander
	.command('upgrade <version>')
	.option('-n, --dry-run', 'See which versions would have been run')
	.option('-y, --yes', 'Answer yes to all prompts')
	.description("Run upgrade scripts between current version and given version")
	.action(async function ( version ) {
	    await runCommand('upgrade', [ version ], this, this.parent);
	});
    
    commander
	.command('downgrade <version>')
	.option('-n, --dry-run', 'See which versions would have been run')
	.option('-y, --yes', 'Answer yes to all prompts')
	.description("Run downgrade scripts between current version and given version")
	.action(async function ( version ) {
	    await runCommand('downgrade', [ version ], this, this.parent);
	});

    commander.parse( argv );

    // console.log( commander );
    
    function help_and_exit() {
	commander.help();
	exit();
    }

    // Catch undefined subcommands
    if ( typeof commander.args[commander.args.length-1] === 'string' ) {
	print( `Error: Unknown subcommand '${commander.args[0]}'` );
	help_and_exit()
    }
    
    // Display help and exit if no subcommands where given
    // if ( commander.args.length === 0 ) {
    // 	print( `Error: no input` )
    // 	help_and_exit()
    // }
}


if ( typeof require != 'undefined' && require.main == module ) {
    main( process.argv );
}
else {
    module.exports = main;
}
