package dev.momo.task;
import java.util.function.Supplier;
/** Only visible samples may refresh a remembered approach position. */
final class SeenTarget<T> {
 private T last;private int missed;private final int budget;
 SeenTarget(T initial,int budget){last=initial;this.budget=budget;}
 T sample(boolean visible,Supplier<T> current){if(visible){last=current.get();missed=0;}else missed++;return last;}
 boolean lost(){return missed>budget;}
}
