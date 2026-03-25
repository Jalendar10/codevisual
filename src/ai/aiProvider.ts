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
    // Only check that vscode.lm exists and the Copilot extension is installed.
    // Do NOT call selectChatModels here — that triggers a VS Code permission
    // dialog at startup before the user has done anything, which they'll miss,
    // causing the dialog to auto-dismiss and models to appear unavailable.
    if (typeof vscode.lm === 'undefined') {
      return false;
    }
    return !!(
      vscode.extensions.getExtension('GitHub.copilot') ||
      vscode.extensions.getExtension('GitHub.copilot-chat')
    );
  }

  /** Pick the best available Copilot model, respecting user's setting. */
  private async selectModel(): Promise<vscode.LanguageModelChat> {
    const all = await this.listAvailableModels();
    if (all.length === 0) {
      throw new Error(
        'No Copilot models are available right now. ' +
        'Check that GitHub Copilot Chat is installed and signed in, then try again. ' +
        'If this is the first use, VS Code may have shown a permission prompt — please accept it and retry.'
      );
    }

    // Respect user model preference from settings
    const config = vscode.workspace.getConfiguration('codeflow');
    const preferred = config.get<string>('ai.model', 'auto');
    if (preferred && preferred !== 'auto' && preferred !== 'copilot-default') {
      // Try exact match first, then partial match
      const exact = all.find(
        (m) => m.id === preferred || m.family === preferred
      );
      if (exact) {
        return exact;
      }
      const partial = all.find(
        (m) => m.id?.includes(preferred) || m.family?.includes(preferred)
      );
      if (partial) {
        return partial;
      }
    }

    // Prefer a GPT-4 class model; fall back to whatever is available
    return all.find((m) => m.family?.includes('gpt-4') || m.id?.includes('gpt-4')) ?? all[0];
  }

  /** List all available Copilot models — exposed so the extension can show a picker. */
  async listAvailableModels(): Promise<vscode.LanguageModelChat[]> {
    try {
      return await vscode.lm.selectChatModels({ vendor: 'copilot' });
    } catch (err) {
      throw new Error(
        `Could not access GitHub Copilot models: ${err instanceof Error ? err.message : String(err)}. ` +
        'Make sure GitHub Copilot Chat is installed, you are signed in, and have accepted the permission request.'
      );
    }
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
            description: s.description || s.message,
            line: typeof s.line === 'number' ? s.line : undefined,
            endLine: typeof s.endLine === 'number' ? s.endLine : undefined,
            original: s.original || '',
            suggested: s.suggested || s.code || '',
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

IMPORTANT: For each suggestion, provide the ORIGINAL code snippet and the SUGGESTED replacement, plus a description of WHY the change is recommended. This is critical for the UI to show a before/after diff.

JSON structure:
{
  "summary": "brief overview of the code — what it does, its architecture, and overall quality",
  "issues": [{"severity": "error|warning|info", "message": "description", "line": number, "suggestion": "fix"}],
  "suggestions": [
    {
      "type": "refactor|performance|security|test|documentation|style",
      "message": "short title of the suggestion",
      "description": "detailed explanation of WHY this change is recommended and how it improves the code",
      "line": <line number where the original code starts>,
      "endLine": <line number where the original code ends>,
      "original": "the original code snippet as-is from the source",
      "suggested": "the improved replacement code",
      "priority": "high|medium|low"
    }
  ],
  "codeQuality": <number 0-100>,
  "testCoverage": "description of test coverage gaps and recommendations",
  "securityConcerns": ["concern1"]
}

CRITICAL: Every suggestion MUST include "line" and "endLine" — the exact line numbers from the source code where the original snippet lives. This lets the user apply the fix directly.

Provide at least 5 deep, actionable suggestions with original/suggested code pairs. Analyze: architecture, SOLID principles, error handling, naming, SQL injection, performance bottlenecks, test coverage gaps, and data flow correctness.

${context.instructions || ''}

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

  /** Expose the copilot provider for direct model listing. */
  getCopilotProvider(): CopilotProvider {
    return this.copilot;
  }
  
  async getCopilotStatus(): Promise<{ available: boolean; provider: string; message: string }> {
    const available = await this.copilot.isAvailable();
    let message: string;
    if (available) {
      message = 'GitHub Copilot is installed. Click AI Analysis to run — VS Code may ask for permission on first use.';
    } else if (typeof vscode.lm === 'undefined') {
      message = 'VS Code 1.90+ is required for AI features via the Language Model API.';
    } else {
      message = 'GitHub Copilot Chat is not installed or not signed in. Install it from the Extensions panel to enable AI analysis.';
    }
    return { available, provider: 'GitHub Copilot', message };
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
