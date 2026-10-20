/**
 * BYOK (Bring Your Own Key) LLM Provider Integrations
 * Supports Gemini, Groq, Grok (xAI), OpenAI (ChatGPT), and Claude (Anthropic).
 */

export type LLMProvider = 'gemini' | 'groq' | 'openai' | 'xai' | 'anthropic';

export interface ModelOption {
  id: string;
  name: string;
  provider: LLMProvider;
}

export class LLMError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
  }
}

/**
 * Dynamically queries the provider API to fetch available models for the given API key.
 */
export async function fetchProviderModels(
  provider: LLMProvider,
  apiKey: string
): Promise<ModelOption[]> {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw new LLMError('missing_key', '請輸入有效的 API Key');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const data: any = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        throw new LLMError('invalid_key', data?.error?.message || `Gemini API 回傳錯誤 (${res.status})`);
      }
      const rawModels: any[] = data?.models || [];
      const chatModels = rawModels
        .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => {
          const id = String(m.name || '').replace(/^models\//, '');
          const name = m.displayName ? `${m.displayName} (${id})` : id;
          return { id, name, provider };
        });

      // Sort with modern 2.5 / 2.0 / 1.5 flash & pro models first
      chatModels.sort((a, b) => {
        const order = (id: string) => {
          if (id.includes('2.5-flash')) return 1;
          if (id.includes('2.5-pro')) return 2;
          if (id.includes('2.0-flash')) return 3;
          if (id.includes('1.5-flash')) return 4;
          if (id.includes('1.5-pro')) return 5;
          return 10;
        };
        return order(a.id) - order(b.id);
      });

      return chatModels.length > 0
        ? chatModels
        : [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider }];
    }

    if (provider === 'groq') {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
      });
      const data: any = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        throw new LLMError('invalid_key', data?.error?.message || `Groq API 回傳錯誤 (${res.status})`);
      }
      const rawModels: any[] = data?.data || [];
      const chatModels = rawModels
        .filter(m => m.active !== false && !m.id.includes('whisper') && !m.id.includes('guard'))
        .map(m => ({ id: m.id, name: `${m.id}`, provider }));

      chatModels.sort((a, b) => {
        const order = (id: string) => {
          if (id.includes('llama-3.3-70b')) return 1;
          if (id.includes('llama-3.1-70b')) return 2;
          if (id.includes('llama-3.1-8b')) return 3;
          return 10;
        };
        return order(a.id) - order(b.id);
      });

      return chatModels;
    }

    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
      });
      const data: any = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        throw new LLMError('invalid_key', data?.error?.message || `OpenAI API 回傳錯誤 (${res.status})`);
      }
      const rawModels: any[] = data?.data || [];
      const chatModels = rawModels
        .filter(m => (m.id.startsWith('gpt-4') || m.id.startsWith('gpt-3.5') || m.id.startsWith('o1') || m.id.startsWith('o3')) && !m.id.includes('instruct') && !m.id.includes('realtime') && !m.id.includes('audio'))
        .map(m => ({ id: m.id, name: `${m.id}`, provider }));

      chatModels.sort((a, b) => {
        const order = (id: string) => {
          if (id === 'gpt-4o') return 1;
          if (id === 'gpt-4o-mini') return 2;
          if (id.startsWith('o1')) return 3;
          if (id.startsWith('o3')) return 4;
          return 10;
        };
        return order(a.id) - order(b.id);
      });

      return chatModels;
    }

    if (provider === 'xai') {
      const res = await fetch('https://api.x.ai/v1/models', {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
      });
      const data: any = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        throw new LLMError('invalid_key', data?.error?.message || `xAI API 回傳錯誤 (${res.status})`);
      }
      const rawModels: any[] = data?.data || [];
      const chatModels = rawModels
        .filter(m => m.id.includes('grok'))
        .map(m => ({ id: m.id, name: `${m.id}`, provider }));

      return chatModels.length > 0
        ? chatModels
        : [{ id: 'grok-2-latest', name: 'grok-2-latest', provider }];
    }

    if (provider === 'anthropic') {
      try {
        const res = await fetch('https://api.anthropic.com/v1/models', {
          signal: controller.signal,
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            Accept: 'application/json',
          },
        });
        const data: any = await res.json().catch(() => null);
        if (res.ok && Array.isArray(data?.data) && data.data.length > 0) {
          return data.data.map((m: any) => ({
            id: m.id,
            name: m.display_name ? `${m.display_name} (${m.id})` : m.id,
            provider,
          }));
        }
      } catch (_) {
        // Fall back to well-known Anthropic models if /v1/models is restricted
      }

      return [
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (最強推理)', provider },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku (極速回應)', provider },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus (旗艦巨型模型)', provider },
      ];
    }

    throw new LLMError('unsupported_provider', `不支援的 LLM 提供商: ${provider}`);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new LLMError('timeout', '連線逾時，無法取得模型清單');
    }
    if (err instanceof LLMError) throw err;
    throw new LLMError('network_error', `無法取得模型清單: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Executes chat inference against the selected BYOK provider.
 */
export async function executeBYOKChat(
  provider: LLMProvider,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 45000
): Promise<string> {
  const key = String(apiKey || '').trim();
  if (!key) throw new LLMError('missing_key', '未提供 LLM 金鑰');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            { role: 'user', parts: [{ text: userPrompt }] },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        }),
      });

      const data: any = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        throw new LLMError('api_error', data?.error?.message || `Gemini 推論錯誤 (${res.status})`);
      }
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new LLMError('empty_response', 'Gemini 未回傳有效文字');
      return text;
    }

    if (provider === 'groq' || provider === 'openai' || provider === 'xai') {
      const endpointMap: Record<string, string> = {
        groq: 'https://api.groq.com/openai/v1/chat/completions',
        openai: 'https://api.openai.com/v1/chat/completions',
        xai: 'https://api.x.ai/v1/chat/completions',
      };
      const endpoint = endpointMap[provider];

      const res = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
      });

      const data: any = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        throw new LLMError('api_error', data?.error?.message || `${provider} 推論錯誤 (${res.status})`);
      }
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new LLMError('empty_response', `${provider} 未回傳有效文字`);
      return text;
    }

    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 2500,
          temperature: 0.2,
        }),
      });

      const data: any = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        throw new LLMError('api_error', data?.error?.message || `Anthropic 推論錯誤 (${res.status})`);
      }
      const text = data?.content?.[0]?.text;
      if (!text) throw new LLMError('empty_response', 'Anthropic 未回傳有效文字');
      return text;
    }

    throw new LLMError('unsupported_provider', `不支援的 LLM 提供商: ${provider}`);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new LLMError('timeout', `模型推論逾時 (${Math.round(timeoutMs / 1000)} 秒)`);
    }
    if (err instanceof LLMError) throw err;
    throw new LLMError('network_error', `模型呼叫失敗: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
