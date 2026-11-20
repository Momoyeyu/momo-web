import {t} from '../i18n';
import IconButton from './IconButton';

export default function DialogBackButton({onClick, disabled}: {onClick: () => void; disabled?: boolean}) {
  const label = t('common.back');
  return <IconButton icon="back" label={label} tip={label} onClick={onClick} disabled={disabled}/>;
}
