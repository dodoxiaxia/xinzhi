"""Retain provider-reported token usage without inferring bills or quota.

Only finite token counters are retained. Unknown usage is explicit, never zero.
This module has no I/O and never changes reservations or validation gates.
"""

TOKEN_FIELDS = ('prompt_tokens', 'completion_tokens', 'total_tokens',
                'input_tokens', 'output_tokens', 'cached_tokens')
DETAIL_FIELDS = ('cached_tokens', 'reasoning_tokens', 'audio_tokens',
                 'accepted_prediction_tokens', 'rejected_prediction_tokens')


def safe_usage(value):
    if not isinstance(value, dict):
        return None
    result = {k: value[k] for k in TOKEN_FIELDS
              if type(value.get(k)) is int and 0 <= value[k] <= 2**53 - 1}
    for key in ('prompt_tokens_details', 'completion_tokens_details',
                'input_tokens_details', 'output_tokens_details'):
        details = value.get(key)
        if isinstance(details, dict):
            kept = {k: details[k] for k in DETAIL_FIELDS
                    if type(details.get(k)) is int and 0 <= details[k] <= 2**53 - 1}
            if kept:
                result[key] = kept
    return result or None


class ModelReply(dict):
    def __init__(self, value, usage=None, finish_reason=None):
        super().__init__(value)
        self.provider_usage = safe_usage(usage)
        self.finish_reason = finish_reason


def record_usage(request, response):
    usage = getattr(response, 'provider_usage', None)
    if usage is None and isinstance(response, dict):
        usage = safe_usage(response.get('usage'))
    if usage is not None:
        request['providerUsageKnown'] = True
        request['providerUsage'] = usage
    elif 'providerUsageKnown' not in request:
        request['providerUsageKnown'] = False
    reason = getattr(response, 'finish_reason', None)
    if reason in ('stop', 'length', 'content_filter', 'tool_calls'):
        request['providerFinishReason'] = reason
