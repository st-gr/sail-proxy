import { Command } from 'commander';
import chalk from 'chalk';
import { readLogs, followLogs, clearLogs, LogService } from '../utils/log-manager';

export const logsCommand = new Command('logs')
  .description('View service logs')
  .argument('[service]', 'Service to view logs for (gateway/ollama/all)', 'all')
  .option('-f, --follow', 'Follow log output (like tail -f)')
  .option('-t, --tail <lines>', 'Number of lines to show from the end of logs', '100')
  .option('-s, --since <time>', 'Show logs since timestamp (e.g., 1h, 30m, 2d)')
  .option('--clear', 'Clear log files')
  .action(async (service: string, options) => {
    try {
      // Determine which services to show logs for
      let services: LogService[] = [];
      
      if (service === 'all') {
        services = ['gateway', 'ollama'];
      } else if (service === 'gateway' || service === 'ollama') {
        services = [service as LogService];
      } else {
        console.error(chalk.red(`Invalid service: ${service}`));
        console.log(chalk.gray('Valid services: gateway, ollama, all'));
        process.exit(1);
      }
      
      // Handle clear option
      if (options.clear) {
        for (const svc of services) {
          clearLogs(svc);
          console.log(chalk.green(`✓ Cleared logs for ${svc}`));
        }
        return;
      }
      
      // Handle follow option
      if (options.follow) {
        await followLogs(services);
        return;
      }
      
      // Parse tail option
      const tail = parseInt(options.tail) || 100;
      if (isNaN(tail) || tail < 1) {
        console.error(chalk.red('Invalid tail value. Must be a positive number.'));
        process.exit(1);
      }
      
      // Show logs for each service
      for (const svc of services) {
        if (services.length > 1) {
          console.log(chalk.blue.bold(`\n=== ${svc.toUpperCase()} LOGS ===\n`));
        }
        
        await readLogs(svc, {
          tail,
          since: options.since
        });
        
        if (services.length > 1 && svc === services[0]) {
          console.log(''); // Add spacing between services
        }
      }
      
    } catch (error) {
      console.error(chalk.red('Error reading logs:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Examples for help text
logsCommand.addHelpText('after', `
Examples:
  $ sail-proxy logs                     # Show last 100 lines from all services
  $ sail-proxy logs gateway              # Show gateway logs only
  $ sail-proxy logs -f                   # Follow all logs in real-time
  $ sail-proxy logs gateway -f           # Follow gateway logs only
  $ sail-proxy logs --tail 50            # Show last 50 lines
  $ sail-proxy logs --since 1h           # Show logs from last hour
  $ sail-proxy logs --clear              # Clear all log files
`);