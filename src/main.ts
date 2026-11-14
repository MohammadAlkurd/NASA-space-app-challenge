import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './styles.css';
import { Game } from './game/Game';

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
if (!canvas) throw new Error('Missing #game-canvas element.');

const game = new Game(canvas);
game.start().catch((error) => {
  console.error(error);
  const status = document.querySelector('#load-status');
  if (status) status.textContent = `Could not load Mars data: ${error instanceof Error ? error.message : error}`;
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose());
}
