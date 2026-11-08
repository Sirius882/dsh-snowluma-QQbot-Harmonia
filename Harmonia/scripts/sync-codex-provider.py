"""Copy only inference configuration into Harmonia's isolated Codex home."""
import json
import os
from pathlib import Path
import sys
import tomllib
import uuid


def encode(value):
    if isinstance(value, dict):
        return '{' + ', '.join(f'{json.dumps(k)} = {encode(v)}' for k, v in value.items()) + '}'
    return json.dumps(value, ensure_ascii=False)


def select_config(source):
    provider = source.get('model_provider', 'openai')
    result = {key: source[key] for key in ('model', 'model_reasoning_effort') if key in source}
    result['model_provider'] = provider
    settings = source.get('model_providers', {}).get(provider)
    if settings:
        # Provider tables describe HTTP inference only; never copy hooks, MCP, skills or instructions.
        keys = ('name', 'base_url', 'wire_api', 'requires_openai_auth', 'env_key',
                'experimental_bearer_token', 'http_headers', 'env_http_headers', 'query_params',
                'supports_websockets', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms')
        result['model_providers'] = {provider: {k: settings[k] for k in keys if k in settings}}
    return result


def main():
    root = Path(__file__).resolve().parents[1]
    source_home = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex'))
    source = source_home / 'config.toml'
    selected = select_config(tomllib.loads(source.read_text(encoding='utf-8-sig')) if source.exists() else {})
    target = root / 'runtime/codex-home/config.toml'
    cache = root.parent / '.cache/harmonia/atomic'
    target.parent.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    text = '\n'.join(f'{json.dumps(k)} = {encode(v)}' for k, v in selected.items()) + '\n'
    tomllib.loads(text)
    temporary = cache / f'{uuid.uuid4()}.toml'
    try:
        temporary.write_text(text, encoding='utf-8')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    provider = selected['model_provider']
    settings = selected.get('model_providers', {}).get(provider, {})
    env_keys = [settings['env_key']] if settings.get('env_key') else []
    env_keys += list(settings.get('env_http_headers', {}).values())
    print(json.dumps({'provider': provider, 'model': selected.get('model'), 'envKeys': env_keys,
                      'custom': provider != 'openai' and bool(settings),
                      'credentialConfigured': bool(settings.get('experimental_bearer_token') or
                                                   (settings.get('env_key') and os.environ.get(settings['env_key'])))}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Provider sync failed ({type(error).__name__}); check local Codex configuration.', file=sys.stderr)
        sys.exit(1)
