import { runGatewaySupervisor } from "./gateway-supervisor.js";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--home" || !args[1]) process.exitCode = 1;
else
  void runGatewaySupervisor(args[1]).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
