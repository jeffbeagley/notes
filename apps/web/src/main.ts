import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';

const router = createRouter({
	history: createWebHistory(),
	routes: [
		{ path: '/', name: 'home', component: App },
		{ path: '/today', name: 'journal', component: App },
		{ path: '/journals', name: 'journalArchive', component: App },
		{ path: '/journals/:date', name: 'journalEntry', component: App },
		{ path: '/places', name: 'places', component: App },
		{ path: '/places/:placeId', name: 'place', component: App },
		{ path: '/notebooks/:notebookId', name: 'notebook', component: App },
		{ path: '/unfiled', name: 'unfiled', component: App },
		{ path: '/notes/:id', name: 'note', component: App },
		{ path: '/tasks/:filter?', name: 'tasks', component: App },
		{ path: '/briefing', name: 'briefing', component: App },
		{ path: '/summaries', name: 'summaries', component: App },
		{ path: '/summaries/:periodKey', name: 'summaryDetail', component: App },
		{ path: '/search', name: 'search', component: App },
		{ path: '/assistant', name: 'assistant', component: App },
		{ path: '/settings', name: 'settings', component: App },
	],
});

createApp(App).use(router).mount('#app');

// Registered here rather than as an inline script so the app runs under a CSP without 'unsafe-inline'.
if ('serviceWorker' in navigator) {
	window.addEventListener('load', () => {
		navigator.serviceWorker.register('/sw.js').catch(() => {});
	});
}