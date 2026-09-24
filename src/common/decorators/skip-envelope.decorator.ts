import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const SKIP_ENVELOPE_KEY = 'skipEnvelope';
export const SkipEnvelope = (): CustomDecorator<string> => SetMetadata(SKIP_ENVELOPE_KEY, true);
