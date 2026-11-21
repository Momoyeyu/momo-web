import {t} from '../i18n';
import Button from './Button';
import Icon from './Icon';

export default function DialogBackButton({onClick, disabled, page = false}: {
  onClick: () => void;
  disabled?: boolean;
  page?: boolean;
}) {
  const label = t('common.back');
  return <Button className={`settings-back tip tip-r${page ? ' settings-back-page' : ''}`}
    aria-label={label} data-tip={label} data-intro={page ? 'settings-back' : undefined}
    sound={false} onClick={onClick} disabled={disabled}>
    <Icon name="back" size={page ? 24 : 21}/>
  </Button>;
}
