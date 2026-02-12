import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  viewChild,
} from '@angular/core';

@Component({
  selector: 'app-viewport',
  templateUrl: './viewport.component.html',
  styleUrl: './viewport.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class ViewportComponent {
  readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly viewportRef = viewChild.required<ElementRef<HTMLDivElement>>('viewport');

  get canvas(): HTMLCanvasElement {
    return this.canvasRef().nativeElement;
  }

  get viewport(): HTMLDivElement {
    return this.viewportRef().nativeElement;
  }
}
