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
  chatMode?: boolean;
  verbose?: boolean;
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
    
    if (this.options.chatMode && this.options.debug) {
      console.log(chalk.magenta(`🔍 CHAT DEBUG: handleRequest called for ${req.method} ${req.url}`));
    }
    
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
      if (this.options.logBody || this.options.chatMode) {
        requestBody = Buffer.concat([requestBody, chunk]);
      }
      proxyReq.write(chunk);
    });

    req.on('end', () => {
      if (this.options.chatMode && this.options.debug) {
        console.log(chalk.magenta(`🔍 CHAT DEBUG: Request ended, body length: ${requestBody.length}, logBody: ${this.options.logBody}`));
      }
      
      if ((this.options.logBody || this.options.chatMode) && requestBody.length > 0) {
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
      if (this.options.logBody || this.options.chatMode) {
        responseBody = Buffer.concat([responseBody, chunk]);
      }
      res.write(chunk);
    });

    proxyRes.on('end', () => {
      if (this.options.chatMode && this.options.debug) {
        console.log(chalk.magenta(`🔍 CHAT DEBUG: Response ended, body length: ${responseBody.length}, logBody: ${this.options.logBody}`));
      }
      
      if ((this.options.logBody || this.options.chatMode) && responseBody.length > 0) {
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
    if (this.options.chatMode && !this.options.logBody) {
      return; // Skip regular request logging in chat mode unless log-body is also enabled
    }
    
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
    if (this.options.chatMode && !this.options.logBody) {
      return; // Skip regular response logging in chat mode unless log-body is also enabled
    }
    
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
    
    if (this.options.chatMode) {
      if (this.options.debug) {
        console.log(chalk.magenta(`🔍 CHAT DEBUG: logRequestBody called with ${body.length} bytes`));
      }
      // For chat mode, we need the full body to extract messages
      const fullBodyStr = this.getFullBody(body, contentEncoding);
      this.extractChatMessage(requestId, fullBodyStr, 'user');
    }
    
    // For display, use formatted (truncated) version
    const bodyStr = this.formatBody(body, contentEncoding);
    
    if (this.options.logBody || this.options.chatMode) {
      if (this.options.chatMode) {
        // Parse and format request in compact way
        this.formatCompactRequest(requestId, bodyStr);
      } else {
        console.log(chalk.cyan(`[${requestId}] 📤 Request Body:`));
        console.log(chalk.gray(bodyStr));
      }
    }
  }

  private logResponseBody(requestId: string, body: Buffer, headers?: http.IncomingHttpHeaders): void {
    const contentType = headers?.['content-type'] as string;
    const contentEncoding = headers?.['content-encoding'] as string;
    
    // Handle Server-Sent Events specially
    if ((this.options.mergeSse || this.options.chatMode) && contentType?.includes('text/event-stream')) {
      this.processSseStream(requestId, body);
      return;
    }
    
    if (this.options.chatMode) {
      if (this.options.debug) {
        console.log(chalk.magenta(`🔍 CHAT DEBUG: logResponseBody called with ${body.length} bytes, content-type: ${contentType}`));
      }
      // For chat mode, we need the full body to extract messages
      const fullBodyStr = this.getFullBody(body, contentEncoding);
      this.extractChatMessage(requestId, fullBodyStr, 'assistant');
    }
    
    // For display, use formatted (truncated) version
    const bodyStr = this.formatBody(body, contentEncoding);
    
    if (this.options.logBody || this.options.chatMode) {
      if (this.options.chatMode) {
        // Parse and format response in compact way
        this.formatCompactResponse(requestId, bodyStr);
      } else {
        console.log(chalk.cyan(`[${requestId}] 📥 Response Body:`));
        console.log(chalk.gray(bodyStr));
        console.log(chalk.gray('─'.repeat(60)));
      }
    }
  }

  private getFullBody(body: Buffer, contentEncoding?: string): string {
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
          return '';
        }
      }

      // Check if it's likely binary data
      if (this.isBinaryData(decompressedBody)) {
        return '';
      }

      return decompressedBody.toString('utf8');
    } catch {
      return '';
    }
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
      
      if (!this.options.chatMode) {
        console.log(chalk.cyan(`[${requestId}] 📥 SSE Stream Started:`));
      } else {
        // In chat mode, show the assistant prefix when starting a new stream
        process.stdout.write(chalk.blue('🤖 '));
      }
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
      
      if (this.options.chatMode) {
        // In chat mode, show streaming text directly
        process.stdout.write(chalk.white(textDeltas.join('')));
      } else {
        console.log(chalk.gray(`[${requestId}] 📝 +${textDeltas.join('')}`));
      }
    }
    
    // Check if stream is complete
    const hasMessageStop = events.some(event => event.event === 'message_stop');
    const hasContentBlockStop = events.some(event => event.event === 'content_block_stop');
    const hasMessageDelta = events.some(event => event.event === 'message_delta' && event.data?.includes('stop_reason'));
    
    if (this.options.debug) {
      console.log(chalk.magenta(`[${requestId}] 🔍 DEBUG: Stream end check - message_stop: ${hasMessageStop}, content_block_stop: ${hasContentBlockStop}, message_delta: ${hasMessageDelta}`));
    }
    
    if (hasMessageStop || hasContentBlockStop || hasMessageDelta) {
      if (this.options.chatMode) {
        console.log(''); // New line after streaming
      } else {
        console.log(chalk.cyan(`[${requestId}] 📥 SSE Complete Message:`));
        console.log(chalk.green(sseMessage.mergedContent || '<empty message>'));
        console.log(chalk.gray('─'.repeat(60)));
      }
      this.sseMessages.delete(requestId);
    }
  }

  private parseSseEvents(sseData: string): SseEvent[] {
    const events: SseEvent[] = [];
    const lines = sseData.split('\n');
    let currentEvent: SseEvent = {};
    
    // Debug logging handled in processSseStream
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (trimmedLine === '') {
        // Empty line indicates end of event
        if (Object.keys(currentEvent).length > 0) {
          events.push(currentEvent);
          // Debug logging handled in processSseStream
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
      // Debug logging handled in processSseStream
    }
    
    return events;
  }

  private formatCompactRequest(_requestId: string, bodyStr: string): void {
    try {
      const data = JSON.parse(bodyStr);
      
      // System prompts - show full content
      if (data.system && Array.isArray(data.system)) {
        data.system.forEach((s: any) => {
          if (s.text) {
            console.log(chalk.yellow(`  📋 System:`));
            console.log(chalk.gray(`  ${s.text}`));
          }
        });
      }
      
      // Show request size for debugging
      console.log(chalk.gray(`  📦 Request: ${bodyStr.length} bytes`));
      
      if (this.options.debug) {
        // In debug mode, show if there are large content blocks
        if (data.messages && Array.isArray(data.messages)) {
          data.messages.forEach((msg: any, idx: number) => {
            if (Array.isArray(msg.content)) {
              msg.content.forEach((item: any) => {
                if (item.type === 'text' && item.text && item.text.length > 1000) {
                  console.log(chalk.magenta(`  🔍 DEBUG: Message[${idx}] contains ${item.text.length} chars`));
                }
              });
            }
          });
        }
      }
    } catch {
      // Not JSON
    }
  }
  
  private formatCompactResponse(_requestId: string, _bodyStr: string): void {
    // In chat mode, we only care about the prompts/content, not metadata
    // Response content is already handled by extractChatMessage
  }
  
  private extractChatMessage(_requestId: string, bodyStr: string, role: 'user' | 'assistant'): void {
    if (this.options.debug) {
      console.log(chalk.magenta(`🔍 CHAT DEBUG: Extracting ${role} message from ${bodyStr.length} chars`));
    }
    
    try {
      const data = JSON.parse(bodyStr);
      if (this.options.debug) {
        console.log(chalk.magenta(`🔍 CHAT DEBUG: Parsed JSON for ${role}:`, JSON.stringify(data, null, 2).substring(0, 200)));
      }
      
      if (role === 'user' && data.messages && Array.isArray(data.messages)) {
        if (this.options.debug) {
          console.log(chalk.magenta(`🔍 CHAT DEBUG: Found ${data.messages.length} messages`));
        }
        
        // Extract ALL messages to see the full conversation
        data.messages.forEach((message: any, idx: number) => {
          if (this.options.debug && idx === data.messages.length - 1) {
            console.log(chalk.magenta(`🔍 CHAT DEBUG: Message[${idx}]:`, JSON.stringify(message).substring(0, 200)));
          }
          
          if (message.role === 'user') {
            console.log('');
            
            // Handle different content formats
            if (typeof message.content === 'string') {
              console.log(chalk.green('👤 ') + chalk.white(message.content));
            } else if (Array.isArray(message.content)) {
              // Complex content array
              message.content.forEach((item: any) => {
                if (item.type === 'text' && item.text) {
                  // Parse and display content smartly
                  if (item.text.includes('<system-reminder>')) {
                    // Extract and show system reminders
                    const reminders = item.text.match(/<system-reminder>([\s\S]*?)<\/system-reminder>/g);
                    if (reminders) {
                      reminders.forEach((reminder: string) => {
                        const content = reminder.replace(/<\/?system-reminder>/g, '').trim();
                        console.log(chalk.yellow('  📋 System Reminder:'));
                        if (this.options.verbose) {
                          console.log(chalk.gray('  ' + content));
                        } else {
                          console.log(chalk.gray('  ' + content.substring(0, 200) + (content.length > 200 ? '...' : '')));
                        }
                      });
                    }
                    
                    // Extract the actual user message
                    const userPart = item.text.split('</system-reminder>').pop()?.trim();
                    if (userPart && userPart.length > 0) {
                      console.log(chalk.green('👤 ') + chalk.white(userPart));
                    }
                  } else if (item.text.includes('Contents of') && item.text.includes('```')) {
                    // File content
                    const fileMatch = item.text.match(/Contents of ([^:]+):/);
                    if (fileMatch) {
                      console.log(chalk.cyan(`  📄 File: ${fileMatch[1]}`));
                      if (this.options.verbose) {
                        console.log(chalk.gray('  ' + item.text));
                      } else {
                        console.log(chalk.gray(`  [${item.text.length} chars of file content]`));
                      }
                    }
                  } else {
                    // Regular message
                    console.log(chalk.green('👤 ') + chalk.white(item.text));
                  }
                } else if (item.type === 'tool_result' && item.content) {
                  // Tool results (like file reads)
                  console.log(chalk.cyan('  🔧 Tool Result:'));
                  // Check if it looks like file content with line numbers
                  if (item.content.match(/^\s*\d+→/m)) {
                    const lines = item.content.split('\n');
                    console.log(chalk.gray(`  [${lines.length} lines of file content]`));
                    if (this.options.verbose) {
                      // Show all lines
                      console.log(chalk.gray('  ' + lines.join('\n  ')));
                    } else {
                      // Show first few lines
                      console.log(chalk.gray('  ' + lines.slice(0, 5).join('\n  ')));
                      if (lines.length > 5) {
                        console.log(chalk.gray('  ...'));
                      }
                    }
                  } else {
                    if (this.options.verbose) {
                      console.log(chalk.gray('  ' + item.content));
                    } else {
                      console.log(chalk.gray('  ' + item.content.substring(0, 200) + (item.content.length > 200 ? '...' : '')));
                    }
                  }
                }
              });
            }
          } else if (message.role === 'assistant' && idx < data.messages.length - 1) {
            // Show previous assistant messages in the conversation
            const content = typeof message.content === 'string' 
              ? message.content 
              : message.content?.[0]?.text || '';
            if (content) {
              if (this.options.verbose) {
                console.log(chalk.blue('🤖 ') + chalk.gray('[previous] ') + chalk.white(content));
              } else {
                console.log(chalk.blue('🤖 ') + chalk.gray('[previous] ') + chalk.white(content.substring(0, 100) + '...'));
              }
            }
          }
        });
      } else if (role === 'assistant' && data.content && Array.isArray(data.content)) {
        if (this.options.debug) {
          console.log(chalk.magenta(`🔍 CHAT DEBUG: Assistant response with ${data.content.length} content items`));
        }
        
        // Extract assistant message from non-streaming response
        const textContent = data.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
          .join('');
        
        if (this.options.debug) {
          console.log(chalk.magenta(`🔍 CHAT DEBUG: Assistant text content: "${textContent}"`));
        }
        
        if (textContent.trim()) {
          console.log(chalk.blue('🤖 ') + chalk.white(textContent));
        }
      } else {
        if (this.options.debug) {
          console.log(chalk.magenta(`🔍 CHAT DEBUG: No matching pattern for ${role}. Data keys:`, Object.keys(data)));
        }
      }
    } catch (error) {
      if (this.options.debug) {
        console.log(chalk.red(`🔍 CHAT DEBUG: JSON parse error for ${role}:`, error));
        console.log(chalk.red(`🔍 CHAT DEBUG: Raw body:`, bodyStr.substring(0, 200)));
      }
    }
  }
}