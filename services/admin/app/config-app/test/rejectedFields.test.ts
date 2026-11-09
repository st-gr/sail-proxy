import { rejectedFields } from '../webapp/model/rejectedFields';

const control = (state: string, text = '') => ({ getValueState: () => state, getValueStateText: () => text });

describe('rejectedFields: fields holding text the document never took', () => {
  it('names a field that refused its value, with its reason', () => {
    expect(rejectedFields({ '/plugins/acme/greeting': control('Error', 'The value is too long. Maximum length is 10') }, []))
      .toEqual(['/plugins/acme/greeting: The value is too long. Maximum length is 10']);
  });

  it('leaves out fields the schema check already marked: they are reported from the document', () => {
    expect(rejectedFields({ '/plugins/acme/retries': control('Error', 'must be <= 5') }, ['/plugins/acme/retries'])).toEqual([]);
  });

  it('leaves out correct fields, and controls with no value state', () => {
    expect(rejectedFields({ '/a': control('None'), '/b': control('Warning', 'look'), '/c': {} as any }, [])).toEqual([]);
  });

  it('with no reason on the field, names the field alone', () => {
    expect(rejectedFields({ '/a': control('Error') }, [])).toEqual(['/a']);
  });
});
