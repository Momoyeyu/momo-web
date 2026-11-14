package dev.momo.task;
import java.util.List;
/** Food policy is local body behavior, not a model decision or a permission grant. */
public final class FoodChoice {
 public record Candidate(int slot,int nutrition,float saturation,boolean unsafe,boolean hunger){}
 public static int choose(List<Candidate> candidates,int foodLevel){
  int best=-1;double score=-Double.MAX_VALUE;
  for(var food:candidates){
   if(food.unsafe||food.nutrition<=0)continue;
   double value=(food.hunger?-10000:0)+4*Math.min(Math.max(1,20-foodLevel),food.nutrition)+food.saturation+(food.slot<9?.001:0);
   if(value>score){score=value;best=food.slot;}
  }
  return best;
 }
 public static int hotbarDestination(List<Integer> empty,int selected){return empty.isEmpty()?selected:empty.getFirst();}
}
