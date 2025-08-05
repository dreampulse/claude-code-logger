#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { ProxyServer } from './proxy-server';

const program = new Command();

program
  .name('middleware-logger')
  .description('HTTP/HTTPS proxy middleware with logging capabilities')
  .version('1.0.0');

program
  .command('start')
  .description('Start the proxy server')
  .requiredOption('-p, --port <port>', 'Local port to listen on', parseInt)
  .requiredOption('-h, --host <host>', 'Remote host address')
  .requiredOption('-r, --remote-port <port>', 'Remote port', parseInt)
  .option('--https', 'Use HTTPS for remote connection', false)
  .option('--local-https', 'Accept HTTPS connections locally', false)
  .option('--log-body', 'Log request and response bodies', false)
  .option('--merge-sse', 'Merge Server-Sent Events into readable messages', false)
  .option('--debug', 'Show debug messages for troubleshooting', false)
  .action(async (options) => {
    try {
      const server = new ProxyServer({
        localPort: options.port,
        remoteHost: options.host,
        remotePort: options.remotePort,
        useHttps: options.https,
        localHttps: options.localHttps,
        logBody: options.logBody,
        mergeSse: options.mergeSse,
        debug: options.debug
      });

      await server.start();
      
      console.log(chalk.green(`🚀 Proxy server started on ${options.localHttps ? 'https' : 'http'}://localhost:${options.port}`));
      console.log(chalk.blue(`📡 Forwarding to ${options.https ? 'https' : 'http'}://${options.host}:${options.remotePort}`));
      console.log(chalk.yellow('📝 Logging all traffic to console...'));
      console.log(chalk.gray('Press Ctrl+C to stop'));

    } catch (error) {
      console.error(chalk.red('❌ Failed to start proxy server:'), error);
      process.exit(1);
    }
  });

program.parse();