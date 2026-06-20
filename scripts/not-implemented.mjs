const [commandName = "command", detail = "Implementation has not landed yet."] =
  process.argv.slice(2);

console.error(`${commandName} is not implemented yet.`);
console.error(detail);
process.exitCode = 1;
