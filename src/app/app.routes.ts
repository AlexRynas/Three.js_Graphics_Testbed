import { Routes } from '@angular/router';

export const routes: Routes = [
	{
		path: '',
		loadComponent: () =>
			import('./features/testbed/testbed.component').then((m) => m.TestbedComponent)
	}
];
