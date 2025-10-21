"use strict";
function parseArgs(argv) {
    const args = { host: 'http://localhost:3000', query: '', include: [], exclude: [], country: undefined };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--host')
            args.host = argv[++i];
        else if (a === '--include')
            args.include.push(argv[++i]);
        else if (a === '--exclude')
            args.exclude.push(argv[++i]);
        else if (a === '--country')
            args.country = argv[++i];
        else
            rest.push(a);
    }
    args.query = rest.join(' ').trim();
    return args;
}
(async () => {
    const argv = process.argv.slice(2);
    const { host, query, include, exclude, country } = parseArgs(argv);
    if (!query) {
        console.error('Usage: npm run interpret -- "<query>" [--host http://localhost:3000] [--include domain] [--exclude domain] [--country cc]');
        process.exit(1);
    }
    const searchSettings = {};
    if (include.length)
        searchSettings.include_domains = include;
    if (exclude.length)
        searchSettings.exclude_domains = exclude;
    if (country)
        searchSettings.country = country;
    const body = {
        query,
        sessionId: `cli_${Date.now()}`,
        enableArtifacts: false,
        searchSettings,
    };
    const res = await fetch(`${host.replace(/\/$/, '')}/api/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
})();
