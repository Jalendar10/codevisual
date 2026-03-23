import * as vscode from 'vscode';
import { AIAnalysisResult, AIIssue, AISuggestion } from '../types';

/**
 * AI Provider interface — all providers implement this.
 */
export interface IAIProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  analyzeCode(code: string, context: AIContext): Promise<AIAnalysisResult>;
  analyzeChanges(diff: string, context: AIContext): Promise<AIAnalysisResult>;
  generateText(prompt: string): Promise<string>;
}

export interface AIContext {
  filePath?: string;
  language?: string;
  projectContext?: string;
  existingCode?: string;
  instructions?: string;
}

/**
 * OpenAI Provider — GPT-4o and GPT-4o-mini
 */
export class OpenAIProvider implements IAIProvider {
  name = 'OpenAI';

  async isAvailable(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('codeVisual');
    const apiKey = config.get<string>('openaiApiKey', '');
    return apiKey.length > 0;
  }

  async analyzeCode(code: string, context: AIContext): Promise<AIAnalysisResult> {
    const config = vscode.workspace.getConfiguration('codeVisual');
    const apiKey = config.get<string>('openaiApiKey', '');
    const model = config.get<string>('openaiModel', 'gpt-4o');

    if (!apiKey) {
      throw new Error('OpenAI API key not configured. Set it in Settings > Code Visual > OpenAI API Key');
    }

    const systemPrompt = `You are an expert code analyzer. Analyze the provided code and return a structured analysis.
Return your response as JSON with this exact structure:
{
  "summary": "Brief overview of the code",
  "issues": [{"severity": "error|warning|info", "message": "description", "line": number, "suggestion": "fix"}],
  "suggestions": [{"type": "refactor|performance|security|test|documentation|style", "message": "description", "priority": "high|medium|low", "code": "suggested code"}],
  "codeQuality": number (0-100),
  "testCoverage": "description of test coverage",
  "securityConcerns": ["concern1", "concern2"]
}`;

    const userPrompt = `Analyze this ${context.language || 'code'} file${context.filePath ? ` (${context.filePath})` : ''}:

\`\`\`${context.language || ''}
${code.slice(0, 15000)}
\`\`\`

${context.instructions || 'Provide a comprehensive code analysis.'}`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 4000,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as any;
      const content = data.choices[0].message.content;
      const result = JSON.parse(content);

      return {
        summary: result.summary || 'Analysis complete',
        issues: (result.issues || []).map((i: any) => ({
          severity: i.severity || 'info',
          message: i.message,
          file: context.filePath,
          line: i.line,
          suggestion: i.suggestion,
        })),
        suggestions: (result.suggestions || []).map((s: any) => ({
          type: s.type || 'refactor',
          message: s.message,
          file: context.filePath,
          code: s.code,
          priority: s.priority || 'medium',
        })),
        codeQuality: result.codeQuality || 70,
        testCoverage: result.testCoverage || 'Unknown',
        securityConcerns: result.securityConcerns || [],
        timestamp: Date.now(),
        provider: 'OpenAI',
        model,
      };
    } catch (error: any) {
      throw new Error(`AI analysis failed: ${error.message}`);
    }
  }

  async analyzeChanges(diff: string, context: AIContext): Promise<AIAnalysisResult> {
    const config = vscode.workspace.getConfiguration('codeVisual');
    const apiKey = config.get<string>('openaiApiKey', '');
    const model = config.get<string>('openaiModel', 'gpt-4o');

    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const systemPrompt = `You are an expert code reviewer. Analyze the git diff and determine:
1. Will the new code work with the existing codebase?
2. Are there any breaking changes?
3. What issues or improvements can you identify?

Return JSON:
{
  "summary": "Overview of changes",
  "issues": [{"severity": "error|warning|info", "message": "desc", "file": "path", "line": number, "suggestion": "fix"}],
  "suggestions": [{"type": "refactor|performance|security|test|documentation|style", "message": "desc", "priority": "high|medium|low"}],
  "codeQuality": number,
  "testCoverage": "description",
  "securityConcerns": [],
  "compatibilityScore": number (0-100),
  "breakingChanges": ["change1"]
}`;

    const userPrompt = `Review these code changes:

${context.existingCode ? `**Existing Code Context:**\n\`\`\`\n${context.existingCode.slice(0, 5000)}\n\`\`\`\n` : ''}

**Git Diff:**
\`\`\`diff
${diff.slice(0, 15000)}
\`\`\`

${context.instructions || 'Analyze if the new code is compatible with the existing codebase and identify any issues.'}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      }),
    });

    const data = await response.json() as any;
    const result = JSON.parse(data.choices[0].message.content);

    return {
      summary: result.summary,
      issues: result.issues || [],
      suggestions: result.suggestions || [],
      codeQuality: result.codeQuality || 70,
      testCoverage: result.testCoverage || 'Unknown',
      securityConcerns: result.securityConcerns || [],
      timestamp: Date.now(),
      provider: 'OpenAI',
      model,
    };
  }

  async generateText(prompt: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('codeVisual');
    const apiKey = config.get<string>('openaiApiKey', '');
    const model = config.get<string>('openaiModel', 'gpt-4o');

    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 4000,
      }),
    });

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }
}

/**
 * GitHub Copilot Provider — uses VS Code's built-in Language Model API (vscode.lm).
 * No CLI, no API key needed — works with the user's existing Copilot subscription.
 */
export class CopilotProvider implements IAIProvider {
  name = 'GitHub Copilot';

  async isAvailable(): Promise<boolean> {
    // vscode.lm requires VS Code 1.90+
    if (typeof vscode.lm === 'undefined') return false;
    // Accept either GitHub.copilot or GitHub.copilot-chat being installed
    const hasCopilot =
      !!vscode.extensions.getExtension('GitHub.copilot') ||
      !!vscode.extensions.getExtension('GitHub.copilot-chat');
    if (!hasCopilot) return false;
    // Confirm at least one model is actually accessible
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      return models.length > 0;
    } catch {
      return false;
    }
  }

  /** Pick the best available Copilot model (prefer gpt-4o family) */
  private async selectModel(): Promise<vscode.LanguageModelChat> {
    const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (all.length === 0) {
      throw new Error(
        'No Copilot models available. Make sure GitHub Copilot Chat is installed and you are signed in.'
      );
    }
    // Prefer a GPT-4 class model if available
    const preferred = all.find(m =>
      m.family?.includes('gpt-4') || m.id?.includes('gpt-4')
    );
    return preferred ?? all[0];
  }

  private async sendPrompt(prompt: string): Promise<string> {
    const model = await this.selectModel();
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    return text;
  }

  private parseResult(responseText: string, modelId: string, providerLabel: string): AIAnalysisResult {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0]);
        return {
          summary: result.summary || 'Analysis complete',
          issues: (result.issues || []).map((i: any) => ({
            severity: i.severity || 'info',
            message: i.message,
            line: i.line,
            suggestion: i.suggestion,
          })),
          suggestions: (result.suggestions || []).map((s: any) => ({
            type: s.type || 'refactor',
            message: s.message,
            priority: s.priority || 'medium',
            code: s.code,
          })),
          codeQuality: typeof result.codeQuality === 'number' ? result.codeQuality : 70,
          testCoverage: result.testCoverage || 'Unknown',
          securityConcerns: result.securityConcerns || [],
          timestamp: Date.now(),
          provider: providerLabel,
          model: modelId,
        };
      } catch {
        // JSON was malformed — fall through to text summary
      }
    }
    return {
      summary: responseText,
      issues: [],
      suggestions: [],
      codeQuality: 70,
      testCoverage: 'Unknown',
      securityConcerns: [],
      timestamp: Date.now(),
      provider: providerLabel,
      model: modelId,
    };
  }

  async analyzeCode(code: string, context: AIContext): Promise<AIAnalysisResult> {
    const model = await this.selectModel();
    const prompt = `You are an expert code reviewer. Analyze the following ${context.language || 'code'} file${context.filePath ? ` (${context.filePath})` : ''} and respond with ONLY a JSON object — no markdown, no explanation, just JSON.

JSON structure:
{
  "summary": "brief overview",
  "issues": [{"severity": "error|warning|info", "message": "description", "line": number, "suggestion": "fix"}],
  "suggestions": [{"type": "refactor|performance|security|test|documentation", "message": "description", "priority": "high|medium|low", "code": "optional snippet"}],
  "codeQuality": <number 0-100>,
  "testCoverage": "description",
  "securityConcerns": ["concern1"]
}

Code:
\`\`\`${context.language || ''}
${code.slice(0, 12000)}
\`\`\``;

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    return this.parseResult(text, model.id, 'GitHub Copilot');
  }

  async analyzeChanges(diff: string, context: AIContext): Promise<AIAnalysisResult> {
    const model = await this.selectModel();
    const prompt = `You are an expert code reviewer. Review this git diff and respond with ONLY a JSON object — no markdown, no explanation, just JSON.

JSON structure:
{
  "summary": "overview of changes",
  "issues": [{"severity": "error|warning|info", "message": "description", "file": "path", "line": number, "suggestion": "fix"}],
  "suggestions": [{"type": "refactor|performance|security|test", "message": "description", "priority": "high|medium|low"}],
  "codeQuality": <number 0-100>,
  "testCoverage": "description",
  "securityConcerns": [],
  "compatibilityScore": <number 0-100>,
  "breakingChanges": ["change1"]
}

Git Diff:
\`\`\`diff
${diff.slice(0, 12000)}
\`\`\``;

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    return this.parseResult(text, model.id, 'GitHub Copilot');
  }

  async generateText(prompt: string): Promise<string> {
    return this.sendPrompt(prompt);
  }
}

/**
 * AI Provider Manager — auto-selects the best available provider.
 * Priority: GitHub Copilot (no extra setup) → OpenAI (if key configured).
 */
export class AIProviderManager {
  private copilot = new CopilotProvider();
  
  async getCopilotStatus(): Promise<{ available: boolean; provider: string; message: string }> {
    const available = await this.copilot.isAvailable();
    return {
      available,
      provider: 'GitHub Copilot',
      message: available
        ? 'GitHub Copilot Chat is available and will be used for AI analysis.'
        : 'GitHub Copilot Chat is not available. Install it and sign in to enable AI analysis.',
    };
  }

  /** Return the Copilot provider only. */
  async getProvider(): Promise<IAIProvider> {
    if (await this.copilot.isAvailable()) {
      return this.copilot;
    }

    throw new Error(
      'GitHub Copilot is not available. Make sure GitHub Copilot Chat is installed and you are signed in.'
    );
  }

  /** Analyze code with the best available provider */
  async analyzeCode(code: string, context: AIContext): Promise<AIAnalysisResult> {
    const provider = await this.getProvider();
    return provider.analyzeCode(code, context);
  }

  /** Analyze git changes */
  async analyzeChanges(diff: string, context: AIContext): Promise<AIAnalysisResult> {
    const provider = await this.getProvider();
    return provider.analyzeChanges(diff, context);
  }

  async generateText(prompt: string): Promise<string> {
    const provider = await this.getProvider();
    return provider.generateText(prompt);
  }
}
