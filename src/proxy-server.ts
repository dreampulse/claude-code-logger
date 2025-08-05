import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as zlib from 'zlib';
import chalk from 'chalk';

export interface ProxyServerOptions {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  useHttps?: boolean;
  localHttps?: boolean;
  logBody?: boolean;
  mergeSse?: boolean;
  debug?: boolean;
}

interface SseEvent {
  event?: string;
  data?: string;
  id?: string;
}

interface SseMessage {
  requestId: string;
  events: SseEvent[];
  mergedContent: string;
}

export class ProxyServer {
  private server: http.Server | https.Server;
  private options: ProxyServerOptions;
  private sseMessages: Map<string, SseMessage> = new Map();

  constructor(options: ProxyServerOptions) {
    this.options = options;
    
    if (options.localHttps) {
      this.server = https.createServer(this.handleRequest.bind(this));
    } else {
      this.server = http.createServer(this.handleRequest.bind(this));
    }

    this.server.on('connect', this.handleConnect.bind(this));
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.options.localPort, () => {
        resolve();
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startTime = Date.now();
    const requestId = Math.random().toString(36).substring(2, 11);
    
    let requestBody = Buffer.alloc(0);
    
    this.logRequest(requestId, req);

    const options: http.RequestOptions | https.RequestOptions = {
      hostname: this.options.remoteHost,
      port: this.options.remotePort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers }
    };

    if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
      delete (options.headers as any).host;
      (options.headers as any).host = `${this.options.remoteHost}:${this.options.remotePort}`;
    }

    const proxyReq = this.options.useHttps 
      ? https.request(options, (proxyRes) => this.handleResponse(requestId, proxyRes, res, startTime))
      : http.request(options, (proxyRes) => this.handleResponse(requestId, proxyRes, res, startTime));

    proxyReq.on('error', (error) => {
      console.error(chalk.red(`[${requestId}] ❌ Proxy request error:`), error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy Error');
      }
    });

    req.on('data', (chunk) => {
      if (this.options.logBody) {
        requestBody = Buffer.concat([requestBody, chunk]);
      }
      proxyReq.write(chunk);
    });

    req.on('end', () => {
      if (this.options.logBody && requestBody.length > 0) {
        this.logRequestBody(requestId, requestBody, req.headers);
      }
      proxyReq.end();
    });

    req.on('error', (error) => {
      console.error(chalk.red(`[${requestId}] ❌ Client request error:`), error.message);
      proxyReq.destroy();
    });
  }

  private handleResponse(
    requestId: string, 
    proxyRes: http.IncomingMessage, 
    res: http.ServerResponse, 
    startTime: number
  ): void {
    const duration = Date.now() - startTime;
    let responseBody = Buffer.alloc(0);
    
    this.logResponse(requestId, proxyRes, duration);

    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

    proxyRes.on('data', (chunk) => {
      if (this.options.logBody) {
        responseBody = Buffer.concat([responseBody, chunk]);
      }
      res.write(chunk);
    });

    proxyRes.on('end', () => {
      if (this.options.logBody && responseBody.length > 0) {
        this.logResponseBody(requestId, responseBody, proxyRes.headers);
      }
      res.end();
    });

    proxyRes.on('error', (error) => {
      console.error(chalk.red(`[${requestId}] ❌ Proxy response error:`), error.message);
      if (!res.writableEnded) {
        res.end();
      }
    });
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const requestId = Math.random().toString(36).substring(2, 11);
    const startTime = Date.now();
    
    console.log(chalk.magenta(`[${requestId}] 🔒 CONNECT ${req.url}`));

    const { hostname, port } = this.parseConnectUrl(req.url || '');
    
    const serverSocket = net.createConnection({
      host: hostname,
      port: parseInt(port)
    }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
      
      const duration = Date.now() - startTime;
      console.log(chalk.green(`[${requestId}] ✅ CONNECT established (${duration}ms)`));
    });

    serverSocket.on('error', (error) => {
      console.error(chalk.red(`[${requestId}] ❌ CONNECT error:`), error.message);
      clientSocket.end();
    });

    clientSocket.on('error', (error) => {
      console.error(chalk.red(`[${requestId}] ❌ Client socket error:`), error.message);
      serverSocket.end();
    });
  }

  private parseConnectUrl(connectUrl: string): { hostname: string; port: string } {
    const parts = connectUrl.split(':');
    return {
      hostname: parts[0],
      port: parts[1] || '443'
    };
  }

  private logRequest(requestId: string, req: http.IncomingMessage): void {
    const timestamp = new Date().toISOString();
    const method = req.method?.toUpperCase() || 'UNKNOWN';
    const url = req.url || '/';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    
    console.log(chalk.cyan(`[${requestId}] 📤 ${timestamp}`));
    console.log(chalk.blue(`[${requestId}] ${method} ${url}`));
    console.log(chalk.gray(`[${requestId}] User-Agent: ${userAgent}`));
    
    if (req.headers['content-length']) {
      console.log(chalk.gray(`[${requestId}] Content-Length: ${req.headers['content-length']}`));
    }
    
    if (req.headers['content-type']) {
      console.log(chalk.gray(`[${requestId}] Content-Type: ${req.headers['content-type']}`));
    }
  }

  private logResponse(requestId: string, proxyRes: http.IncomingMessage, duration: number): void {
    const statusCode = proxyRes.statusCode || 0;
    const statusColor = statusCode >= 400 ? chalk.red : statusCode >= 300 ? chalk.yellow : chalk.green;
    
    console.log(chalk.cyan(`[${requestId}] 📥 Response`));
    console.log(statusColor(`[${requestId}] ${statusCode} ${proxyRes.statusMessage || ''} (${duration}ms)`));
    
    if (proxyRes.headers['content-length']) {
      console.log(chalk.gray(`[${requestId}] Content-Length: ${proxyRes.headers['content-length']}`));
    }
    
    if (proxyRes.headers['content-type']) {
      console.log(chalk.gray(`[${requestId}] Content-Type: ${proxyRes.headers['content-type']}`));
    }
    
    console.log(chalk.gray('─'.repeat(60)));
  }

  private logRequestBody(requestId: string, body: Buffer, headers?: http.IncomingHttpHeaders): void {
    const contentEncoding = headers?.['content-encoding'] as string;
    const bodyStr = this.formatBody(body, contentEncoding);
    console.log(chalk.cyan(`[${requestId}] 📤 Request Body:`));
    console.log(chalk.gray(bodyStr));
  }

  private logResponseBody(requestId: string, body: Buffer, headers?: http.IncomingHttpHeaders): void {
    const contentType = headers?.['content-type'] as string;
    const contentEncoding = headers?.['content-encoding'] as string;
    
    // Handle Server-Sent Events specially
    if (this.options.mergeSse && contentType?.includes('text/event-stream')) {
      this.processSseStream(requestId, body);
      return;
    }
    
    const bodyStr = this.formatBody(body, contentEncoding);
    console.log(chalk.cyan(`[${requestId}] 📥 Response Body:`));
    console.log(chalk.gray(bodyStr));
    console.log(chalk.gray('─'.repeat(60)));
  }

  private formatBody(body: Buffer, contentEncoding?: string): string {
    const maxLength = 1000;
    let bodyStr: string;

    try {
      // Handle compressed content
      let decompressedBody = body;
      if (contentEncoding) {
        try {
          switch (contentEncoding.toLowerCase()) {
            case 'gzip':
              decompressedBody = zlib.gunzipSync(body);
              break;
            case 'deflate':
              decompressedBody = zlib.inflateSync(body);
              break;
            case 'br':
              decompressedBody = zlib.brotliDecompressSync(body);
              break;
          }
        } catch {
          return `<Compressed data (${contentEncoding}): ${body.length} bytes - decompression failed>`;
        }
      }

      // Check if it's likely binary data
      if (this.isBinaryData(decompressedBody)) {
        return `<Binary data: ${body.length} bytes${contentEncoding ? ` (${contentEncoding})` : ''}>`;
      }

      bodyStr = decompressedBody.toString('utf8');
      
      if (this.isJsonContent(bodyStr)) {
        try {
          const parsed = JSON.parse(bodyStr);
          bodyStr = JSON.stringify(parsed, null, 2);
        } catch {
          // Keep original if JSON parsing fails
        }
      }
    } catch {
      return `<Binary data: ${body.length} bytes${contentEncoding ? ` (${contentEncoding})` : ''}>`;
    }

    if (bodyStr.length > maxLength) {
      bodyStr = bodyStr.substring(0, maxLength) + '\n... (truncated)';
    }

    return bodyStr;
  }

  private isBinaryData(buffer: Buffer): boolean {
    // Check for null bytes in first 512 bytes
    const sample = buffer.subarray(0, Math.min(512, buffer.length));
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) {
        return true;
      }
    }
    return false;
  }

  private isJsonContent(str: string): boolean {
    const trimmed = str.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || 
           (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  private processSseStream(requestId: string, body: Buffer): void {
    const bodyStr = body.toString('utf8');
    const events = this.parseSseEvents(bodyStr);
    
    if (this.options.debug) {
      console.log(chalk.magenta(`[${requestId}] 🔍 DEBUG: Processing ${body.length} bytes, found ${events.length} events`));
    }
    
    // Get or create SSE message tracker
    let sseMessage = this.sseMessages.get(requestId);
    if (!sseMessage) {
      sseMessage = {
        requestId,
        events: [],
        mergedContent: ''
      };
      this.sseMessages.set(requestId, sseMessage);
      console.log(chalk.cyan(`[${requestId}] 📥 SSE Stream Started:`));
    }
    
    // Add new events
    sseMessage.events.push(...events);
    
    // Debug: Show event types
    const eventTypes = events.map(e => e.event).filter(Boolean);
    if (this.options.debug && eventTypes.length > 0) {
      console.log(chalk.magenta(`[${requestId}] 🔍 DEBUG: Event types: ${eventTypes.join(', ')}`));
    }
    
    // Extract and merge text content
    const textDeltas = events
      .filter(event => event.event === 'content_block_delta')
      .map(event => {
        try {
          const data = JSON.parse(event.data || '{}');
          if (this.options.debug) {
            console.log(chalk.magenta(`[${requestId}] 🔍 DEBUG: Delta data: ${JSON.stringify(data)}`));
          }
          const text = data.delta?.text || '';
          if (this.options.debug) {
            console.log(chalk.magenta(`[${requestId}] 🔍 DEBUG: Extracted text: "${text}"`));
          }
          return text;
        } catch (error) {
          if (this.options.debug) {
            console.log(chalk.red(`[${requestId}] 🔍 DEBUG: JSON parse error: ${error}`));
          }
          return '';
        }
      })
      .filter(text => text.length > 0);
    
    if (this.options.debug) {
      console.log(chalk.magenta(`[${requestId}] 🔍 DEBUG: Found ${textDeltas.length} text deltas: ${JSON.stringify(textDeltas)}`));
    }
    
    if (textDeltas.length > 0) {
      sseMessage.mergedContent += textDeltas.join('');
      console.log(chalk.gray(`[${requestId}] 📝 +${textDeltas.join('')}`));
    }
    
    // Check if stream is complete
    const hasMessageStop = events.some(event => event.event === 'message_stop');
    const hasContentBlockStop = events.some(event => event.event === 'content_block_stop');
    const hasMessageDelta = events.some(event => event.event === 'message_delta' && event.data?.includes('stop_reason'));
    
    if (this.options.debug) {
      console.log(chalk.magenta(`[${requestId}] 🔍 DEBUG: Stream end check - message_stop: ${hasMessageStop}, content_block_stop: ${hasContentBlockStop}, message_delta: ${hasMessageDelta}`));
    }
    
    if (hasMessageStop || hasContentBlockStop || hasMessageDelta) {
      console.log(chalk.cyan(`[${requestId}] 📥 SSE Complete Message:`));
      console.log(chalk.green(sseMessage.mergedContent || '<empty message>'));
      console.log(chalk.gray('─'.repeat(60)));
      this.sseMessages.delete(requestId);
    }
  }

  private parseSseEvents(sseData: string): SseEvent[] {
    const events: SseEvent[] = [];
    const lines = sseData.split('\n');
    let currentEvent: SseEvent = {};
    
    if (this.options.debug) {
      console.log(chalk.magenta(`🔍 DEBUG: Parsing SSE data (${sseData.length} chars):`));
      console.log(chalk.gray(sseData.substring(0, 200) + (sseData.length > 200 ? '...' : '')));
    }
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (trimmedLine === '') {
        // Empty line indicates end of event
        if (Object.keys(currentEvent).length > 0) {
          events.push(currentEvent);
          if (this.options.debug) {
            console.log(chalk.magenta(`🔍 DEBUG: Added event: ${JSON.stringify(currentEvent)}`));
          }
          currentEvent = {};
        }
      } else if (trimmedLine.startsWith('event:')) {
        currentEvent.event = trimmedLine.substring(6).trim();
      } else if (trimmedLine.startsWith('data:')) {
        const data = trimmedLine.substring(5).trim();
        currentEvent.data = (currentEvent.data || '') + data;
      } else if (trimmedLine.startsWith('id:')) {
        currentEvent.id = trimmedLine.substring(3).trim();
      }
    }
    
    // Add last event if exists
    if (Object.keys(currentEvent).length > 0) {
      events.push(currentEvent);
      if (this.options.debug) {
        console.log(chalk.magenta(`🔍 DEBUG: Added final event: ${JSON.stringify(currentEvent)}`));
      }
    }
    
    return events;
  }
}