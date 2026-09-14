import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
// Fail loud: a missing mount point means index.html and the bundle disagree, which would otherwise
// show as a blank page with a clean console.
if (target === null) throw new Error('subagent-router console: #app mount point is missing from index.html');

mount(App, { target });
