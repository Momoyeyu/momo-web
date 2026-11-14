package dev.momo.task;
import java.util.List;
public final class FoodChoiceSmoke {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){
  var poisonous=new FoodChoice.Candidate(0,2,3.2f,true,false);
  var flesh=new FoodChoice.Candidate(1,4,.8f,false,true);
  var bread=new FoodChoice.Candidate(17,5,6,false,false);
  check(FoodChoice.choose(List.of(poisonous),14)==-1,"Automatic eating must not consume poison just because it is the only food");
  check(FoodChoice.choose(List.of(poisonous,flesh,bread),14)==17,"Safe backpack food wins over harmful or hunger food");
  check(FoodChoice.choose(List.of(flesh),14)==1,"Hunger food remains a usable last resort");
  check(FoodChoice.choose(List.of(new FoodChoice.Candidate(18,5,6,false,false),new FoodChoice.Candidate(2,5,6,false,false)),14)==2,"Equivalent hotbar food avoids an unnecessary inventory mutation");
  check(FoodChoice.choose(List.of(new FoodChoice.Candidate(3,0,0,false,false)),14)==-1,"Non-nutritious items are not recovery food");
  check(FoodChoice.hotbarDestination(List.of(0,2),5)==0,"Use an empty hotbar slot before replacing equipment");
  check(FoodChoice.hotbarDestination(List.of(),5)==5,"A full hotbar can swap without throwing anything away");
  System.out.println("PASS safe food choice, backpack selection and lossless hotbar preparation");
 }
}
