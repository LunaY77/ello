import { useReducer } from 'react';

import { slashCommands } from '../../slash-commands.js';
import { composerReducer, initialComposerState, suggestComposer } from '../state/composer-reducer.js';

/** composer controller，集中处理输入、历史和 suggestions。 */
export function useComposerController() {
  const [state, dispatch] = useReducer(composerReducer, initialComposerState);
  const commands = slashCommands.map((command) => command.name);
  return {
    state,
    insert(text: string) {
      dispatch({ type: 'insert', text });
      dispatch({ type: 'suggestions.set', suggestions: suggestComposer(`${state.value}${text}`, commands) });
    },
    newline() {
      dispatch({ type: 'newline' });
    },
    backspace() {
      dispatch({ type: 'backspace' });
    },
    clear() {
      dispatch({ type: 'clear' });
    },
    submitted(value: string) {
      dispatch({ type: 'submitted', value });
    },
    historyPrev() {
      dispatch({ type: 'history.prev' });
    },
    historyNext() {
      dispatch({ type: 'history.next' });
    },
  };
}
