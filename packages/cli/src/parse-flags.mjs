// Argv parser shared between the bin entry and its tests. Keeps the bin
// file small enough that the only thing left to cover via subprocess is
// the subcommand-dispatch table itself.
export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--project') flags.project = true;
    else if (a === '--no-hook') flags['no-hook'] = true;
    else if (a === '--url') flags.url = argv[++i];
    else if (a === '--file') flags.file = argv[++i];
    else if (a === '--port') flags.port = argv[++i];
    else if (a === '--screenshot') flags.screenshot = argv[++i];
    else if (a === '--install') flags.install = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}
