import { createRoot } from 'react-dom/client';
import { App } from './App';
import { HomePage } from './home/HomePage';
import { openProject } from './api';
import { projectIdSchema } from '../shared/projects';
import './design/tokens.css';
import './design/components.css';
import './styles.css';

// `/` is the home page and `/projects/<id>` a project. Moving between them loads the page again,
// so nothing from one project's workspace stays in memory in another.
const match = location.pathname.match(/^\/projects\/([\w-]+)\/?$/),
  project = match ? projectIdSchema.safeParse(match[1]) : null;
if (project?.success) openProject(project.data);

createRoot(document.getElementById('root')!).render(project?.success ? <App /> : <HomePage />);
