import { describe, expect, it } from 'vitest';

import { composerRows, resolveComposerSubmit } from '../composer-input.js';

describe('composer input helpers', () => {
  it('turns trailing backslash submit into a newline insertion', () => {
    expect(resolveComposerSubmit('first line\\')).toEqual({
      submitted: false,
      value: 'first line\n',
    });
  });

  it('submits normal values unchanged', () => {
    expect(resolveComposerSubmit('send me')).toEqual({
      submitted: true,
      value: 'send me',
    });
  });

  it('splits multiline values into stable rows', () => {
    expect(composerRows('one\ntwo')).toEqual(['one', 'two']);
  });
});
