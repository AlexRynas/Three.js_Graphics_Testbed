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
  private canvasElement: HTMLCanvasElement | null = null;

  get canvas(): HTMLCanvasElement {
    this.canvasElement ??= this.canvasRef().nativeElement;
    return this.canvasElement;
  }

  get viewport(): HTMLDivElement {
    return this.viewportRef().nativeElement;
  }

  resetCanvas(): HTMLCanvasElement {
    const current = this.canvas;
    const next = current.cloneNode(true) as HTMLCanvasElement;
    current.replaceWith(next);
    this.canvasElement = next;
    return next;
  }
}
